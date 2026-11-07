"""Combine bundles built from different Splunk instances into one catalog.

A real deployment spreads metadata across instances: search heads (knowledge
objects, ES), indexers (indexes, data), a Deployment Server, DB Connect heavy
forwarders, SOAR, UBA. Each is built on its own (``build --instance <id>``); this
module joins them and recomputes what crosses instances:

- **References** a bundle could not resolve on its own, and every wildcard
  pattern, are re-resolved against all instances (``bundle["references"]``).
  Only global object types (indexes, sourcetypes, hosts, SOAR labels, ...) match
  across instances, by name; ``web`` on two indexer clusters is linked to both.
- **Hosts**: deployment clients, forwarders and Stream forwarders are linked again
  to the ``host`` values seen on any instance.
- Broken-reference diagnostics fixed by another instance are cleared, objects
  that gained consumers lose their "unused" flag, and governance is recomputed.

Inputs must come from distinct instance ids and must not be redacted (redact the
merged result instead).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import PurePath
from typing import Any

from . import SCHEMA_VERSION, __version__
from .bundle import apply_versions, ref_from_json, ref_to_json
from .fields import link_fields
from .governance import apply_governance
from .health import CONSUMER_EDGES, SEVERITY
from .health import _merge_usage as merge_usage
from .link import link_hosts
from .resolve import Resolver


class MergeError(ValueError):
    pass


def _short(label: str) -> str:
    """File or folder name only: full local paths do not belong in a published bundle."""
    p = PurePath(label)
    return p.parent.name if p.name == "catalog.json" and p.parent.name else p.name


def _is_stub_index(e: dict[str, Any]) -> bool:
    """An index known only from observations (tstats, license) on this instance, as a search
    head sees the indexers' indexes; the configured index lives on another instance."""
    return e["type"] == "index" and set(e.get("properties") or {}) <= {"observed"}


def _fold_stub(stub: dict[str, Any], target: dict[str, Any]) -> None:
    obs = (stub.get("properties") or {}).get("observed") or {}
    t_obs = target.setdefault("properties", {}).setdefault("observed", {})
    for k, v in obs.items():
        t_obs.setdefault(k, v)
    if stub.get("usage"):
        merge_usage(target.setdefault("usage", {}), stub["usage"])
        if not stub["usage"].get("unused"):
            target["usage"].pop("unused", None)
            target["usage"].pop("reason", None)
    if stub.get("health"):
        h = target.setdefault("health", {"status": "ok", "checks": []})
        known = {c["check"] for c in h["checks"]}
        h["checks"].extend(c for c in stub["health"]["checks"] if c["check"] not in known)
        h["status"] = max(
            (c["status"] for c in h["checks"]), key=lambda s: SEVERITY[s], default="ok"
        )
    if stub.get("annotations") and not target.get("annotations"):
        target["annotations"] = stub["annotations"]


def _key(edge: dict[str, Any]) -> tuple[str, str, str]:
    return edge["from"], edge["to"], edge["type"]


def merge_bundles(
    bundles: list[tuple[str, dict[str, Any]]],
    generated_at: datetime | None = None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """``bundles`` is a list of (source label, bundle). Returns the merged bundle."""
    if len(bundles) < 2:
        raise MergeError("merge needs at least two bundles")
    instances: list[dict[str, Any]] = []
    owner: dict[str, str] = {}
    for label, b in bundles:
        if b.get("redaction"):
            raise MergeError(
                f"{label} is redacted; merge unredacted bundles, then redact the result"
            )
        if not str(b.get("schemaVersion", "")).startswith("0.1."):
            raise MergeError(f"{label}: unsupported schema version {b.get('schemaVersion')}")
        for inst in b["instances"]:
            if inst["id"] in owner:
                raise MergeError(
                    f"instance id {inst['id']!r} appears in both {owner[inst['id']]} "
                    f"and {label}; build each instance with its own --instance"
                )
            owner[inst["id"]] = label
            instances.append(inst)

    entities: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    edges: list[dict[str, Any]] = []
    edge_keys: set[tuple[str, str, str]] = set()
    reports: list[dict[str, Any]] = []
    open_refs: list[dict[str, Any]] = []
    glossary: dict[str, dict[str, Any]] = {}
    taxonomy: dict[str, dict[str, Any]] = {}
    domains: dict[str, dict[str, Any]] = {}
    structured: dict[str, dict[str, Any]] = {}
    products: dict[str, dict[str, Any]] = {}
    source = None
    for label, b in bundles:
        main = b["instances"][0]["id"] if b["instances"] else label
        for e in b["entities"]:
            if e["id"] in seen_ids:
                raise MergeError(f"entity {e['id']} appears in more than one bundle")
            seen_ids.add(e["id"])
            entities.append(e)
        for edge in b["edges"]:
            if _key(edge) not in edge_keys:
                edge_keys.add(_key(edge))
                edges.append(edge)
        for r in b.get("ingestionReport", []):
            if r["connector"] in ("governance", "merge"):
                continue  # recomputed below
            reports.append({**r, "instance": r.get("instance", main)})
        open_refs.extend(b.get("references", []))
        for t in b.get("glossary", []):
            glossary.setdefault(t["term"].lower(), t)
        for c in b.get("classifications", []):
            taxonomy.setdefault(c["name"], c)
        for sp in b.get("structuredProperties", []):
            structured.setdefault(sp["id"], sp)
        for dom in b.get("domains", []):
            domains.setdefault(dom["name"], dom)
        for prod in b.get("dataProducts", []):
            if prod["name"] in products:  # the same product annotated in several bundles
                merged_assets = set(products[prod["name"]]["assets"]) | set(prod["assets"])
                products[prod["name"]]["assets"] = sorted(merged_assets)
            else:
                products[prod["name"]] = {**prod, "assets": list(prod["assets"])}
        source = source or b.get("annotationSource")

    # 0. fold observation-only index stubs into the configured index on another instance
    configured: dict[str, list[dict[str, Any]]] = {}
    for e in entities:
        if e["type"] == "index" and not _is_stub_index(e):
            configured.setdefault(e["name"], []).append(e)
    id_map: dict[str, str] = {}
    for e in entities:
        if not _is_stub_index(e):
            continue
        targets = [t for t in configured.get(e["name"], []) if t["instance"] != e["instance"]]
        if len(targets) == 1:  # several indexer clusters with this name: leave it alone
            _fold_stub(e, targets[0])
            id_map[e["id"]] = targets[0]["id"]
    if id_map:
        entities = [e for e in entities if e["id"] not in id_map]
        remapped, edge_keys = [], set()
        for edge in edges:
            edge = {
                **edge,
                "from": id_map.get(edge["from"], edge["from"]),
                "to": id_map.get(edge["to"], edge["to"]),
            }
            if _key(edge) not in edge_keys and edge["from"] != edge["to"]:
                edge_keys.add(_key(edge))
                remapped.append(edge)
        edges = remapped
        for j in open_refs:
            j["known"] = id_map.get(j["known"], j["known"])

    by_id = {e["id"]: e for e in entities}
    new_edges: list[dict[str, Any]] = []

    def add(edge: dict[str, Any]) -> None:
        if edge["from"] in by_id and edge["to"] in by_id and _key(edge) not in edge_keys:
            edge_keys.add(_key(edge))
            new_edges.append(edge)

    # 1. re-resolve references across instances
    resolver = Resolver(entities)
    still_open: list[dict[str, Any]] = []
    for j in open_refs:
        ref = ref_from_json(j)
        matches = resolver.candidates(ref.target)
        for m in matches:
            a, b = (ref.known, m["id"]) if ref.known_is_from else (m["id"], ref.known)
            if a != b:
                add({"from": a, "to": b, "type": ref.edge_type, "origin": ref.origin})
        if matches:
            known = by_id.get(ref.known)
            lin = (known or {}).get("lineage") or {}
            label = f"{ref.target.type}:{ref.target.name}"
            if label in lin.get("unresolved", []):
                lin["unresolved"].remove(label)
                if not lin["unresolved"]:
                    lin.pop("unresolved")
                if not lin:
                    known.pop("lineage", None)
        if not matches or ref.target.pattern:
            still_open.append(ref_to_json(ref))  # patterns stay open for further merges

    # 2. machines to hosts on any instance
    for edge in link_hosts(entities):
        add(edge)

    # 3. searches to fields of sourcetypes they now reach on another instance
    for edge in link_fields(entities, [*edges, *new_edges]):
        add(edge)

    edges.extend(new_edges)

    # 4. objects that gained consumers or producers elsewhere are no longer unused
    gained = {e["to"] for e in new_edges if e["type"] in (*CONSUMER_EDGES, "writes", "feeds")}
    revived = 0
    for eid in gained:
        u = by_id[eid].get("usage") or {}
        if u.pop("unused", None):
            u.pop("reason", None)
            u.pop("builtin", None)
            revived += 1

    ts = (generated_at or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    generated = ts.isoformat().replace("+00:00", "Z")
    entities.sort(key=lambda e: e["id"])
    merged: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated,
        "generator": {"name": "delvecat-ingest", "version": __version__},
        "instances": instances,
        "entities": entities,
        "edges": sorted(edges, key=lambda e: (e["from"], e["type"], e["to"])),
        "ingestionReport": reports,
        "mergedFrom": [
            {
                "instances": [i["id"] for i in b["instances"]],
                "generatedAt": b["generatedAt"],
                "source": _short(label),
            }
            for label, b in bundles
        ],
    }
    if glossary:
        merged["glossary"] = sorted(glossary.values(), key=lambda t: t["term"].lower())
    if taxonomy:
        merged["classifications"] = sorted(taxonomy.values(), key=lambda c: c["name"])
    if structured:
        merged["structuredProperties"] = sorted(structured.values(), key=lambda d: d["id"])
    if domains:
        merged["domains"] = sorted(domains.values(), key=lambda d: d["name"].lower())
    if products:
        for prod in products.values():  # assets may have been folded into other ids
            prod["assets"] = sorted({id_map.get(a, a) for a in prod["assets"]})
        merged["dataProducts"] = sorted(products.values(), key=lambda p: p["name"].lower())
    if source:
        merged["annotationSource"] = source
    if still_open:
        merged["references"] = still_open
    if previous is not None:
        merged["changes"] = apply_versions(entities, generated, previous)

    apply_governance(merged)
    merged["ingestionReport"].append(
        {
            "connector": "merge",
            "status": "ok",
            "counts": {
                "bundles": len(bundles),
                "instances": len(instances),
                "crossInstanceEdges": len(new_edges),
                "foldedIndexes": len(id_map),
                "openReferences": len(still_open),
                "noLongerUnused": revived,
            },
        }
    )
    return merged
