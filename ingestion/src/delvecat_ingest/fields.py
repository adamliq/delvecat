"""Connect searches to the sourcetype fields they read, and fields to the
configuration that defines them.

Two steps, both on finished entities and edges:

``define_fields`` adds a ``field`` entity (``inst:field:<sourcetype>/<name>``)
for every field that props.conf defines for a sourcetype: inline extractions
(named regex groups), transforms used by REPORT- extractions (named groups and
FIELDS), field aliases, calculated fields and automatic lookup outputs. Fields
already found by sampling events are reused. Each definer gets a
``definesField`` edge to its field and ``readsField`` edges to the fields it
reads (an alias's original field, a calculated field's inputs, a lookup's
input fields).

``link_fields`` reads ``lineage.fields`` (from SPL analysis) and adds
``readsField`` edges from a search to the fields it uses on the sourcetypes it
reads, directly or through the indexes it reads. Fields of data models,
lookups and other searches' results are not linked: there are no field
entities for them.

``fill_lookup_fields`` shares field lists between a lookup definition and the
file or KV Store collection behind it, so each lists the lookup's fields.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

_NAMED_GROUP = re.compile(r"\(\?P?<([A-Za-z_]\w*)>")
_IDENT = re.compile(r"'([^']+)'|\"(?:[^\"\\]|\\.)*\"|(?<![\w.$])([A-Za-z_][\w.:]*)(\s*\()?")
_KEYWORDS = {"and", "or", "not", "xor", "like", "in", "true", "false", "null"}
_NON_SOURCETYPE = ("source::", "host::", "rule::", "delayedrule::")

DEFINER_TYPES = ("fieldExtraction", "fieldAlias", "calculatedField", "automaticLookup")


def _sourcetype(stanza: str | None) -> str | None:
    if not stanza or stanza.startswith(_NON_SOURCETYPE) or "*" in stanza:
        return None
    return stanza


def _expression_fields(expr: str) -> list[str]:
    out = []
    for m in _IDENT.finditer(expr or ""):
        quoted, name, call = m.group(1), m.group(2), m.group(3)
        if quoted:
            out.append(quoted)
        elif name and not call and name.lower() not in _KEYWORDS:
            out.append(name)
    return out


def lookup_columns(e: dict[str, Any]) -> list[str]:
    """The fields of a lookup (definition or file) or KV Store collection."""
    f = (e.get("properties") or {}).get("fields")
    if isinstance(f, dict):
        return list(f)
    return [str(x) for x in f] if isinstance(f, list) else []


def _is_file(e: dict[str, Any]) -> bool:
    return (e.get("properties") or {}).get("kind") == "file"


def fill_lookup_fields(entities: list[dict[str, Any]]) -> int:
    """Give lookup definitions without a field list the fields of their file or KV Store
    collection, and files those of the definition that reads them. Returns how many."""
    files = {
        (e["instance"], e["name"].split("/")[-1]): e
        for e in entities
        if e["type"] == "lookup" and _is_file(e)
    }
    collections = {
        (e["instance"], e["name"].split("/")[-1]): e
        for e in entities
        if e["type"] == "kvCollection"
    }
    n = 0
    for d in entities:
        p = d.get("properties") or {}
        if d["type"] != "lookup" or p.get("kind") == "file":
            continue
        source = files.get((d["instance"], str(p.get("filename")))) or collections.get(
            (d["instance"], str(p.get("collection")))
        )
        if not source:
            continue
        if not lookup_columns(d) and (cols := lookup_columns(source)):
            p["fields"], p["fieldsFrom"] = cols, source["id"]
            n += 1
        sp = source.setdefault("properties", {})
        if (
            source["type"] == "lookup"
            and not lookup_columns(source)
            and (cols := lookup_columns(d))
        ):
            sp["fields"], sp["fieldsFrom"] = cols, d["id"]
            n += 1
    return n


def _definitions(
    e: dict[str, Any],
    transforms: dict[tuple[str, str], dict[str, Any]],
    lookups: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> tuple[list[str], list[str]]:
    """(fields defined, fields read) by a props.conf knowledge object."""
    p = e.get("properties") or {}
    t = e["type"]
    if t == "fieldExtraction":
        if str(p.get("kind", "")).lower().startswith("uses"):
            defined: list[str] = []
            for name in re.split(r"[,\s]+", str(p.get("value") or "")):
                tr = transforms.get((e["instance"], name))
                if not tr:
                    continue
                tp = tr.get("properties") or {}
                defined += _NAMED_GROUP.findall(str(tp.get("REGEX") or ""))
                defined += [
                    f.strip().strip('"')
                    for f in str(tp.get("FIELDS") or "").split(",")
                    if f.strip()
                ]
            return defined, []
        return _NAMED_GROUP.findall(str(p.get("value") or "")), []
    if t == "fieldAlias":
        defined, read = [], []
        for key, alias in (p.get("aliases") or {}).items():
            original = re.sub(r"^\d+\.", "", str(key))
            for a in str(alias).split():
                defined.append(a)
            read.append(original)
        return defined, read
    if t == "calculatedField":
        return ([p["field"]] if p.get("field") else []), _expression_fields(
            str(p.get("expression") or "")
        )
    if t == "automaticLookup":
        outputs = [v or k for k, v in (p.get("outputFields") or {}).items()]
        inputs = [v or k for k, v in (p.get("inputFields") or {}).items()]
        if not outputs and (lk := (lookups or {}).get((e["instance"], str(p.get("lookup"))))):
            # No OUTPUT list: every lookup field other than the ones matched on is added.
            keys = set(p.get("inputFields") or {})
            outputs = [c for c in lookup_columns(lk) if c not in keys and not c.startswith("_")]
        return outputs, inputs
    return [], []


def define_fields(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add config-defined field entities to ``entities``; return the new edges."""
    by_id = {e["id"]: e for e in entities}
    transforms = {
        (e["instance"], e["name"].split("/")[-1]): e for e in entities if e["type"] == "transform"
    }
    lookups = {
        (e["instance"], e["name"].split("/")[-1]): e
        for e in entities
        if e["type"] == "lookup" and (e.get("properties") or {}).get("kind") != "file"
    }
    edges: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    def edge(a: str, b: str, type_: str) -> None:
        if (a, b, type_) not in seen and a != b:
            seen.add((a, b, type_))
            edges.append({"from": a, "to": b, "type": type_, "origin": "config"})

    def field_id(instance: str, sourcetype: str, name: str, create: bool) -> str | None:
        st_id = f"{instance}:sourcetype:{sourcetype}"
        fid = f"{instance}:field:{sourcetype}/{name}"
        if fid in by_id:
            return fid
        if not create or st_id not in by_id or not name or name.startswith("_"):
            return None
        f = {
            "id": fid,
            "type": "field",
            "name": f"{sourcetype}/{name}",
            "displayName": name,
            "product": "splunk",
            "instance": instance,
            "properties": {"sourcetype": sourcetype, "field": name, "definedIn": "configuration"},
        }
        entities.append(f)
        by_id[fid] = f
        edge(st_id, fid, "contains")
        return fid

    for e in list(entities):
        if e["type"] not in DEFINER_TYPES:
            continue
        st = _sourcetype((e.get("properties") or {}).get("stanza"))
        if not st:
            continue
        defined, read = _definitions(e, transforms, lookups)
        for name in dict.fromkeys(defined):
            fid = field_id(e["instance"], st, name, create=True)
            if fid:
                edge(e["id"], fid, "definesField")
        for name in dict.fromkeys(read):
            fid = field_id(e["instance"], st, name, create=True)
            if fid:
                edge(e["id"], fid, "readsField")
    return edges


def link_fields(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """``readsField`` edges from searches to the sourcetype fields they use."""
    ids = {e["id"] for e in entities}
    feeds: dict[str, set[str]] = defaultdict(set)  # index -> sourcetypes
    reads: dict[str, set[str]] = defaultdict(set)  # entity -> indexes / sourcetypes read
    for x in edges:
        to_type = x["to"].split(":", 2)[1]
        from_type = x["from"].split(":", 2)[1]
        if x["type"] == "feeds" and from_type == "sourcetype" and to_type == "index":
            feeds[x["to"]].add(x["from"])
        elif x["type"] == "reads" and to_type in ("index", "sourcetype"):
            reads[x["from"]].add(x["to"])
    out: list[dict[str, Any]] = []
    for e in entities:
        fl = (e.get("lineage") or {}).get("fields")
        if not fl or fl.get("source") != "events" or not fl.get("used"):
            continue
        sourcetypes: set[str] = set()
        direct = {r for r in reads[e["id"]] if r.split(":", 2)[1] == "sourcetype"}
        if direct:
            sourcetypes = direct  # sourcetype= narrows the data the search reads
        else:
            for r in reads[e["id"]]:
                sourcetypes |= feeds.get(r, set())
        for st in sourcetypes:
            instance, _, name = st.split(":", 2)
            for u in fl["used"]:
                fid = f"{instance}:field:{name}/{u['name']}"
                if fid in ids:
                    out.append({"from": e["id"], "to": fid, "type": "readsField", "origin": "spl"})
    return out
