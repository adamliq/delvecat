"""Assemble, version, validate and write catalog bundles."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from . import SCHEMA_VERSION, __version__
from .attribute import attribute_products
from .fields import define_fields, link_fields
from .health import apply_usage, evaluate_health, mark_unused
from .lineage import derive, record_unresolved
from .link import link_hosts
from .model import GLOBAL_TYPES, ExtractResult, Ref, Target
from .resolve import Resolver

# Bookkeeping and human annotations never count as a change to the Splunk object.
_VERSION_FIELDS = (
    "version",
    "firstSeenAt",
    "contentHash",
    "annotations",
    "lineage",
    "usage",
    "health",
)


def find_schema(start: Path | None = None, name: str = "catalog.schema.json") -> Path:
    """Locate ``schemas/<name>`` by walking up from cwd and this file."""
    relative = Path("schemas") / name
    for base in (start or Path.cwd(), Path(__file__).resolve()):
        for parent in (base, *base.parents):
            candidate = parent / relative
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(f"could not find {relative}")


# --- references kept for cross-instance merging ----------------------------------------


def ref_to_json(ref: Ref) -> dict[str, Any]:
    t = ref.target
    target: dict[str, Any] = {"type": t.type, "name": t.name}
    if t.app:
        target["app"] = t.app
    if t.pattern:
        target["pattern"] = True
    return {
        "known": ref.known,
        "edgeType": ref.edge_type,
        "target": target,
        "knownIsFrom": ref.known_is_from,
        "origin": ref.origin,
    }


def ref_from_json(d: dict[str, Any]) -> Ref:
    t = d["target"]
    return Ref(
        d["known"],
        Target(t["type"], t["name"], t.get("app"), t.get("pattern", False)),
        d["edgeType"],
        d.get("knownIsFrom", True),
        d.get("origin", "config"),
    )


def cross_instance_refs(refs: list[Ref], unresolved: list[Ref]) -> list[dict[str, Any]]:
    """References another instance may satisfy: unresolved ones, and every wildcard pattern
    (a role's ``web*`` should also match indexes on other indexers). Only global object
    types, where names mean the same thing across instances."""
    keep = {id(r) for r in unresolved}
    out, seen = [], set()
    for r in refs:
        if r.target.type not in GLOBAL_TYPES or r.target.visible_only:
            continue
        if id(r) in keep or r.target.pattern:
            j = ref_to_json(r)
            key = json.dumps(j, sort_keys=True)
            if key not in seen:
                seen.add(key)
                out.append(j)
    return out


# --- merging --------------------------------------------------------------------------


def _merge_value(a: Any, b: Any) -> Any:
    if a in (None, "", [], {}):
        return b
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = _merge_value(a.get(k), v) if k in a else v
        return out
    if isinstance(a, list) and isinstance(b, list):
        return a + [x for x in b if x not in a]
    return a


def merge_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Combine entities that share an id (e.g. a sourcetype from props.conf and from tstats,
    or an index from REST and from ACS). The first non-empty value wins; dicts and lists merge.
    """
    merged: dict[str, dict[str, Any]] = {}
    for e in entities:
        if e["id"] in merged:
            merged[e["id"]] = _merge_value(merged[e["id"]], e)
        else:
            merged[e["id"]] = e
    return list(merged.values())


# --- versioning -----------------------------------------------------------------------


def content_hash(entity: dict[str, Any]) -> str:
    """Hash of what an entity *is*, ignoring run-to-run measurements and bookkeeping."""
    core = {k: v for k, v in entity.items() if k not in (*_VERSION_FIELDS, "updatedAt")}
    if isinstance(core.get("properties"), dict):
        core["properties"] = {k: v for k, v in core["properties"].items() if k != "observed"}
    raw = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def apply_versions(
    entities: list[dict[str, Any]], generated_at: str, previous: dict[str, Any] | None
) -> dict[str, Any] | None:
    prev = {e["id"]: e for e in (previous or {}).get("entities", [])}
    added, modified = [], []
    for e in entities:
        h = content_hash(e)
        old = prev.get(e["id"])
        if old is None:
            e["version"], e["firstSeenAt"] = 1, generated_at
            added.append(e["id"])
        else:
            e["firstSeenAt"] = old.get("firstSeenAt", generated_at)
            e["version"] = old.get("version", 1)
            if (old.get("contentHash") or content_hash(old)) != h:
                e["version"] += 1
                modified.append(e["id"])
        e["contentHash"] = h
    if previous is None:
        return None
    ids = {e["id"] for e in entities}
    removed = [
        {"id": i, "type": o["type"], "name": o["name"]} for i, o in prev.items() if i not in ids
    ]
    return {
        "previousGeneratedAt": previous["generatedAt"],
        "added": sorted(added),
        "removed": sorted(removed, key=lambda r: r["id"]),
        "modified": sorted(modified),
    }


# --- assembly -------------------------------------------------------------------------


def assemble(
    instances: list[dict[str, Any]],
    result: ExtractResult,
    generated_at: datetime | None = None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ts = (generated_at or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    generated = ts.isoformat().replace("+00:00", "Z")
    entities = merge_entities(result.entities)
    attribute_products(entities)
    spl_refs = derive(entities)
    result.edges.extend(link_hosts(entities))
    result.edges.extend(define_fields(entities))
    all_refs = [*result.refs, *spl_refs]
    resolved, unresolved = Resolver(entities).resolve(all_refs)
    broken = record_unresolved({e["id"]: e for e in entities}, unresolved)
    open_refs = cross_instance_refs(all_refs, unresolved)

    # Drop dangling edges (e.g. to an app that was not extracted) and duplicates.
    ids = {e["id"] for e in entities}
    seen: set[tuple[str, str, str]] = set()
    edges, dangling = [], 0
    for edge in [*result.edges, *resolved]:
        key = (edge["from"], edge["to"], edge["type"])
        if edge["from"] not in ids or edge["to"] not in ids:
            dangling += 1
        elif key not in seen:
            seen.add(key)
            edges.append(edge)
    field_edges = 0
    for edge in link_fields(entities, edges):
        key = (edge["from"], edge["to"], edge["type"])
        if key not in seen:
            seen.add(key)
            edges.append(edge)
            field_edges += 1

    reports = list(result.reports)
    if spl_refs:
        issue_keys = ("unresolved", "warnings", "implicitIndex", "dynamic")
        with_issues = sum(
            1 for e in entities if any(k in (e.get("lineage") or {}) for k in issue_keys)
        )
        broken = sum(len((e.get("lineage") or {}).get("unresolved", [])) for e in entities)
        reports.append(
            {
                "connector": "lineage",
                "status": "ok",
                "counts": {
                    "splReferences": len(spl_refs),
                    "brokenReferences": broken,
                    "objectsWithIssues": with_issues,
                    "fieldReferences": field_edges,
                },
            }
        )
    if result.refs:
        config_unresolved = [r for r in unresolved if r.origin != "spl"]
        examples = sorted({f"{r.target.type}:{r.target.name}" for r in config_unresolved})[:10]
        reports.append(
            {
                "connector": "resolver",
                "status": "ok",
                "counts": {
                    "references": len(result.refs),
                    "unresolved": len(unresolved),
                    "danglingEdges": dangling,
                },
                **(
                    {"message": "unresolved targets include " + ", ".join(examples)}
                    if examples
                    else {}
                ),
            }
        )

    # Usage, health and cleanup (derived; outside the content hash).
    available = {
        r["connector"].split(".", 1)[1]
        for r in result.reports
        if r["status"] == "ok" and r["connector"].startswith("splunk.")
    }
    apply_usage(entities, result.usage, result.adhoc_searches)
    instance_since = [(i.get("properties") or {}).get("schedulerLogSince") for i in instances]
    since = (result.instance_facts.get("properties") or {}).get("schedulerLogSince") or next(
        (x for x in instance_since if x), None
    )
    evaluate_health(entities, result.as_of or generated, since)
    unused = mark_unused(entities, edges, available)
    if result.usage or result.adhoc_searches or any(k.startswith("health") for k in available):
        statuses = [e["health"]["status"] for e in entities if e.get("health")]
        reports.append(
            {
                "connector": "health",
                "status": "ok",
                "counts": {
                    "critical": statuses.count("critical"),
                    "warning": statuses.count("warning"),
                    "unused": unused,
                },
                "message": f"as of {result.as_of or generated}",
            }
        )

    entities.sort(key=lambda e: e["id"])
    changes = apply_versions(entities, generated, previous)
    bundle: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated,
        "generator": {"name": "delvecat-ingest", "version": __version__},
        "instances": instances,
        "entities": entities,
        "edges": sorted(edges, key=lambda e: (e["from"], e["type"], e["to"])),
        "ingestionReport": reports,
        **({"references": open_refs} if open_refs else {}),
    }
    if changes is not None:
        bundle["changes"] = changes
    return bundle


def validate(bundle: dict[str, Any], schema_path: Path | None = None) -> list[str]:
    """Return a list of human-readable problems (empty when valid)."""
    schema = json.loads((schema_path or find_schema()).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    problems = [
        f"{'/'.join(map(str, err.absolute_path)) or '<root>'}: {err.message}"
        for err in validator.iter_errors(bundle)
    ]
    seen: set[str] = set()
    dupes: set[str] = set()
    for e in bundle.get("entities", []):
        (dupes if e.get("id") in seen else seen).add(e.get("id"))
    problems.extend(f"duplicate entity id: {d}" for d in sorted(dupes))
    return problems


# --- reading / writing ----------------------------------------------------------------


def _dump(data: Any, pretty: bool) -> bytes:
    if pretty:
        text = json.dumps(data, indent=2, ensure_ascii=False)
    else:
        text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return (text + "\n").encode()


def write_bundle(
    bundle: dict[str, Any], out: Path, *, shard: bool = False, pretty: bool = False
) -> list[Path]:
    """Write a single-file bundle, or (``shard=True``) a directory with a manifest
    ``catalog.json`` plus one file per entity type and one for edges."""
    if not shard:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(_dump(bundle, pretty))
        return [out]
    out.mkdir(parents=True, exist_ok=True)
    written, shards = [], []
    by_type: dict[str, list[dict[str, Any]]] = {}
    for e in bundle["entities"]:
        by_type.setdefault(e["type"], []).append(e)
    parts: list[tuple[str, str, str | None, list[dict[str, Any]]]] = [
        (f"entities/{t}.json", "entities", t, items) for t, items in sorted(by_type.items())
    ]
    parts.append(("edges.json", "edges", None, bundle["edges"]))
    for rel, kind, etype, items in parts:
        data = _dump({kind: items}, pretty)
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        written.append(path)
        shard_info = {
            "path": rel,
            "kind": kind,
            "count": len(items),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        if etype:
            shard_info["entityType"] = etype
        shards.append(shard_info)
    manifest = {**bundle, "entities": [], "edges": [], "shards": shards}
    (out / "catalog.json").write_bytes(_dump(manifest, pretty))
    return [out / "catalog.json", *written]


def load_bundle(path: Path) -> dict[str, Any]:
    """Read a bundle file, a manifest file, or a directory containing ``catalog.json``.
    Shards are inlined so callers always see the full bundle."""
    if path.is_dir():
        path = path / "catalog.json"
    bundle = json.loads(path.read_text(encoding="utf-8"))
    shards = bundle.pop("shards", None)
    if shards:
        for s in shards:
            data = (path.parent / s["path"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != s["sha256"]:
                raise ValueError(f"shard {s['path']} does not match its sha256")
            bundle[s["kind"]].extend(json.loads(data)[s["kind"]])
    return bundle
