"""Carry classifications along lineage at column level.

Old behaviour: a classified index made everything derived from it classified.
Now each classification travels with the *columns* that hold it:

* A classified field makes its sourcetype classified in that column, and the
  indexes the sourcetype feeds. A field derived from it by a field alias,
  calculated field or automatic lookup is classified too.
* An object classified as a whole (annotated on an index, lookup, table...) is
  classified in every column. Nothing more precise is known about it.
* A search with field lineage passes a classification on only through result
  columns computed from a classified column. Counts, distinct counts and
  hashes (``masked`` columns) pass nothing on. When its result shape is
  unknown, classified columns pass through by name. If a whole object is
  classified, every column computed from any field carries it.
* A search reads a classification only if it uses a classified column (or
  reads data classified as a whole).
* ``stopsClassifications`` on an object stops those classifications (and
  their children; ``*`` stops all) from going past it.
* Objects without field lineage (alert actions, inputs, searches that name
  no fields) pass classified columns on unchanged. Data models, and inputs a
  search cannot match by name (a lookup used through ``| lookup``, another
  search's results read from a different kind of data), count as classified
  in every column, as before.
"""

from __future__ import annotations

import re
from collections import defaultdict, deque
from typing import Any

ALL = None  # every column

STORE_TYPES = frozenset(
    {"index", "sourcetype", "lookup", "kvCollection", "externalTable", "dataModel", "field"}
)
DEFINER_TYPES = frozenset({"fieldExtraction", "fieldAlias", "calculatedField", "automaticLookup"})
FLOW_FORWARD = {"feeds", "writes", "triggers", "accelerates", "deploys"}
FLOW_REVERSE = {"reads", "uses", "mapsTo"}
MAX_DEPTH = 8

# Inputs whose columns a search refers to by name, by the kind of data it searches.
_MATCHABLE = {
    "events": {"index", "sourcetype", "macro", "eventtype"},
    "lookup": {"lookup", "kvCollection", "macro"},
    "search": {"savedSearch", "correlationSearch", "macro"},
    "database": {"externalTable", "dbConnection", "macro"},
}


def _union(a: frozenset[str] | None, b: frozenset[str] | None) -> frozenset[str] | None:
    return ALL if a is ALL or b is ALL else a | b


def stops(entity: dict[str, Any], cls: str) -> bool:
    for s in (entity.get("annotations") or {}).get("stopsClassifications", []):
        if s == "*" or cls == s or cls.startswith(s + "."):
            return True
    return False


def _field_name(f: dict[str, Any]) -> str:
    p = f.get("properties") or {}
    return str(p.get("field") or f.get("displayName") or f["name"].rsplit("/", 1)[-1])


def _alias_pairs(d: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = defaultdict(list)
    for k, v in ((d.get("properties") or {}).get("aliases") or {}).items():
        out[re.sub(r"^\d+\.", "", str(k))].extend(str(v).split())
    return out


def derived_fields(by_id: dict[str, Any], edges: list[dict[str, Any]]) -> dict[str, set[str]]:
    """field id -> ids it takes its values from: the fields an alias or calculated
    field is made from, or the lookup an automatic lookup returns values from (not
    its input fields: those are only the key)."""
    defines: dict[str, list[str]] = defaultdict(list)
    reads: dict[str, list[str]] = defaultdict(list)
    for x in edges:
        t = by_id.get(x["from"], {}).get("type")
        if x["type"] == "definesField":
            defines[x["from"]].append(x["to"])
        elif (
            x["type"] == "readsField"
            and t in DEFINER_TYPES
            and t != "automaticLookup"
            or (
                x["type"] == "uses"
                and t == "automaticLookup"
                and x["to"].split(":", 2)[1] == "lookup"
            )
        ):
            reads[x["from"]].append(x["to"])
    out: dict[str, set[str]] = defaultdict(set)
    for d, defined in defines.items():
        definer = by_id.get(d)
        if not definer:
            continue
        pairs = _alias_pairs(definer) if definer["type"] == "fieldAlias" else None
        for src in reads.get(d, []):
            for dst in defined:
                if dst == src or dst not in by_id or src not in by_id:
                    continue
                aliased = pairs is not None and by_id[src]["type"] == "field"
                if not aliased or _field_name(by_id[dst]) in pairs.get(_field_name(by_id[src]), []):
                    out[dst].add(src)
    return out


def propagate(
    by_id: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    seeds: dict[str, dict[str, frozenset[str] | None]],
    carried: set[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]], dict[str, set[str]]]:
    """Spread classifications from ``seeds`` (node -> class -> columns or ALL).

    Only classes in ``carried`` travel along lineage. Returns
    (derived: node -> class -> {"columns", "via"}, readers: node -> classes it
    reads, stopped: node -> classes it stops).
    """
    preds: dict[str, list[str]] = defaultdict(list)
    succs: dict[str, list[str]] = defaultdict(list)
    for x in edges:
        if x["type"] in FLOW_FORWARD:
            a, b = x["from"], x["to"]
        elif x["type"] in FLOW_REVERSE:
            a, b = x["to"], x["from"]
        else:
            continue
        if a != b and a in by_id and b in by_id:
            preds[b].append(a)
            succs[a].append(b)
    defines: dict[str, list[str]] = defaultdict(list)
    for x in edges:
        if x["type"] == "definesField" and x["to"] in by_id:
            defines[x["from"]].append(_field_name(by_id[x["to"]]))

    # Objects with stop annotations, so the hot loop does not read annotations each time.
    stoppers = {
        eid for eid, e in by_id.items() if (e.get("annotations") or {}).get("stopsClassifications")
    }
    derived: dict[str, dict[str, Any]] = defaultdict(dict)
    readers: dict[str, set[str]] = defaultdict(set)
    stopped: dict[str, set[str]] = defaultdict(set)

    classes = {c for per in seeds.values() for c in per if c in carried}
    for cls in sorted(classes):
        cols: dict[str, frozenset[str] | None] = {}
        via: dict[str, str] = {}
        depth: dict[str, int] = {}
        queue: deque[str] = deque()
        for node, per in seeds.items():
            if cls in per:
                cols[node] = per[cls]
                depth[node] = 0
                queue.append(node)

        def out_cols(
            node: str,
            cls: str = cls,
            cols: dict[str, frozenset[str] | None] = cols,
        ) -> frozenset[str] | None:
            """What a node passes on (after stops)."""
            if node in stoppers and stops(by_id[node], cls):
                return frozenset()
            return cols.get(node, frozenset())

        # Level by level: everything downstream of the last level's changes is evaluated
        # once per level (a node with many inputs is not re-evaluated for each of them).
        # Objects pass changes on while their shortest distance from a seed is under
        # MAX_DEPTH (as before); levels repeat until nothing changes.
        frontier = list(queue)
        level = 0
        while frontier:
            level += 1
            dirty = dict.fromkeys(
                nxt
                for node in frontier
                if depth[node] < MAX_DEPTH
                for nxt in succs.get(node, [])
                if by_id[nxt]["type"] != "field"
            )
            changed: list[str] = []
            for nxt in dirty:
                e = by_id[nxt]
                inputs = [(p, out_cols(p)) for p in preds[nxt] if p in cols]
                inputs = [(p, c) for p, c in inputs if c is ALL or c]
                if not inputs:
                    continue
                new, reads = _evaluate(e, inputs, by_id, defines.get(nxt, []))
                if reads:
                    readers[nxt].add(cls)
                if cls in seeds.get(nxt, {}):
                    new = _union(new, seeds[nxt][cls])
                if nxt in stoppers and stops(e, cls) and (new is ALL or new):
                    stopped[nxt].add(cls)
                old = cols.get(nxt, frozenset())
                if new is not ALL and not new:
                    continue
                merged = _union(old, new) if nxt in cols else new
                if nxt in cols and merged == old:
                    continue
                cols[nxt] = merged
                via.setdefault(nxt, min(p for p, _ in inputs))
                depth[nxt] = min(depth.get(nxt, level), level)
                changed.append(nxt)
            frontier = changed
        for node, c in cols.items():
            if node in seeds and cls in seeds[node]:
                continue
            derived[node][cls] = {"columns": c, "via": via.get(node)}
    return derived, readers, stopped


def _evaluate(
    e: dict[str, Any],
    inputs: list[tuple[str, frozenset[str] | None]],
    by_id: dict[str, dict[str, Any]],
    defined_names: list[str],
) -> tuple[frozenset[str] | None, bool]:
    """(columns the node carries, whether it reads the classification)."""
    fl = (e.get("lineage") or {}).get("fields")
    if e["type"] in DEFINER_TYPES:
        return (frozenset(defined_names) if defined_names else ALL), True
    if e["type"] == "dataModel":  # its fields are named Dataset.field, unlike the events
        return ALL, True
    if fl is None:  # no column evidence: pass on what comes in
        src: frozenset[str] | None = frozenset()
        for _, c in inputs:
            src = _union(src, c)
        return src, True
    matchable = _MATCHABLE.get(fl.get("source", ""), set())
    src = frozenset()
    for p, c in inputs:
        src = _union(src, c if by_id[p]["type"] in matchable else ALL)
    used = {u["name"] for u in fl.get("used", [])}
    reads = src is ALL or bool(used & src)
    outputs = fl.get("outputs")
    if outputs is None:
        return src, reads
    carried = frozenset(
        o["name"]
        for o in outputs
        if not o.get("masked") and o["from"] and (src is ALL or set(o["from"]) & src)
    )
    return carried, reads
