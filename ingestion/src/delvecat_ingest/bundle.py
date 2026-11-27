"""Assemble, version, validate and write catalog bundles."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from . import SCHEMA_VERSION, __version__
from .attribute import attribute_products
from .compat import UTC
from .fields import define_fields, fill_lookup_fields, link_fields
from .health import (
    apply_health_history,
    apply_usage,
    evaluate_health,
    fill_alert_fires,
    mark_unused,
    thresholds,
)
from .lineage import derive, record_unresolved, runtime_lookups
from .link import link_hosts
from .model import GLOBAL_TYPES, ExtractResult, Ref, Target
from .resolve import Resolver
from .risk import risk_table

# Bookkeeping and human annotations never count as a change to the Splunk object.
CHURN_TYPES = frozenset({"adhocSearch"})
_VERSION_FIELDS = (
    "version",
    "firstSeenAt",
    "contentHash",
    "annotations",
    "lineage",
    "usage",
    "health",
    "quality",
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


MAX_DIFFS = 2000  # modified objects whose changes are listed
MAX_DIFF_KEYS = 25
MAX_DIFF_VALUE = 300


def _short(value: Any) -> Any:
    """A value small enough to show: scalars as they are, the rest as JSON text, cut."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = (
        value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
    )
    return text if len(text) <= MAX_DIFF_VALUE else text[: MAX_DIFF_VALUE - 1] + "…"


def property_diff(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    """What changed between two versions of an object, key by key (properties one level
    down), leaving out run-to-run measurements and bookkeeping."""
    skip = {*_VERSION_FIELDS, "updatedAt", "properties"}

    def flat(e: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in e.items() if k not in skip}
        for k, v in (e.get("properties") or {}).items():
            if k != "observed":
                out[f"properties.{k}"] = v
        return out

    a, b = flat(old), flat(new)
    rows = []
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            rows.append({"key": key, "before": _short(a.get(key)), "after": _short(b.get(key))})
    return rows[:MAX_DIFF_KEYS]


HISTORY_BUILDS = 9  # earlier builds whose changes are kept besides the latest
HISTORY_DIFFS = 300  # modified objects whose details are kept for each earlier build


def change_history(previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The changes of earlier builds, newest first: the previous catalog's own changes
    (marked with when it was built) followed by its history, trimmed."""
    if not previous or not previous.get("changes"):
        return []
    last = dict(previous["changes"])
    last["generatedAt"] = previous.get("generatedAt")
    details = last.get("details") or {}
    if len(details) > HISTORY_DIFFS:
        last["details"] = {k: details[k] for k in sorted(details)[:HISTORY_DIFFS]}
    return [last, *(previous.get("changeHistory") or [])][:HISTORY_BUILDS]


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
    # Ad-hoc searches come and go with what people type: not changes to the deployment.
    churn = {e["id"] for e in entities if e["type"] in CHURN_TYPES}
    # Types the previous catalog had none of were not collected then (an upgrade added
    # them): their objects are new to the catalog, not changes to the deployment.
    known_types = {o["type"] for o in prev.values()}
    churn |= {e["id"] for e in entities if e["type"] not in known_types}
    added = [i for i in added if i not in churn]
    modified = [i for i in modified if i not in churn]
    removed = [r for r in removed if r["type"] not in CHURN_TYPES]
    by_id = {e["id"]: e for e in entities}
    details = {
        i: d for i in sorted(modified)[:MAX_DIFFS] if (d := property_diff(prev[i], by_id[i]))
    }
    return {
        "previousGeneratedAt": previous["generatedAt"],
        **({"details": details} if details else {}),
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
    fill_lookup_fields(entities)
    result.edges.extend(define_fields(entities))
    all_refs = [*result.refs, *spl_refs]
    resolved, unresolved = Resolver(entities).resolve(all_refs)
    created, runtime_edges, unresolved = runtime_lookups(entities, unresolved)
    entities.extend(created)
    result.edges.extend(runtime_edges)
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
    if "usageAlerts" in available:
        fill_alert_fires(
            entities, (result.instance_facts.get("properties") or {}).get("alertUsageWindow")
        )
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
                "thresholds": thresholds(),
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
        if history := change_history(previous):
            bundle["changeHistory"] = history
    if any(r["connector"] == "health" for r in reports):
        apply_health_history(bundle, previous, generated)
    elif previous and previous.get("healthHistory"):
        bundle["healthHistory"] = previous["healthHistory"]  # a partial build keeps the trend
    from .quality import apply_quality  # built-in checks; annotations add more later

    apply_quality(bundle)
    return bundle


# Objects per validation job, and the size from which jobs run in parallel processes.
_CHUNK = 20000
_PARALLEL_FROM = 40000


def _check_edges(edges: list[Any], schema: dict[str, Any]) -> list[str]:
    """Edges have a fixed, flat shape: checked directly (the schema's rules, read from it)
    instead of through the general validator, which takes minutes on millions of them."""
    spec = schema["$defs"]["Edge"]
    required = set(spec["required"])
    allowed = set(spec["properties"])
    types = set(schema["$defs"]["EdgeType"]["enum"])
    origins = set(spec["properties"]["origin"]["enum"])
    problems = []
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            problems.append(f"edges/{i}: {e!r} is not of type 'object'")
            continue
        for k in sorted(required - e.keys()):
            problems.append(f"edges/{i}: '{k}' is a required property")
        extra = sorted(e.keys() - allowed)
        if extra:
            problems.append(
                f"edges/{i}: Additional properties are not allowed ({', '.join(map(repr, extra))} "
                f"{'was' if len(extra) == 1 else 'were'} unexpected)"
            )
        for k in ("from", "to"):
            if k in e and not isinstance(e[k], str):
                problems.append(f"edges/{i}/{k}: {e[k]!r} is not of type 'string'")
        if "type" in e and e["type"] not in types:
            problems.append(f"edges/{i}/type: {e['type']!r} is not one of {sorted(types)}")
        if "origin" in e and e["origin"] not in origins:
            problems.append(f"edges/{i}/origin: {e['origin']!r} is not one of {sorted(origins)}")
        if len(problems) > 1000:
            break
    return problems


def _schema_errors(bundle: dict[str, Any], schema: dict[str, Any], offset: int = 0) -> list[str]:
    # Imported here: the Splunk app runs without jsonschema (it ships compiled code).
    from jsonschema import Draft202012Validator, FormatChecker

    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    out = []
    for err in validator.iter_errors(bundle):
        path = list(err.absolute_path)
        if offset and len(path) > 1 and path[0] == "entities" and isinstance(path[1], int):
            path[1] += offset
        out.append(f"{'/'.join(map(str, path)) or '<root>'}: {err.message}")
    return out


def _entity_job(args: tuple[dict[str, Any], dict[str, Any], int]) -> list[str]:
    shell, schema, offset = args
    return _schema_errors(shell, schema, offset)


def validate(bundle: dict[str, Any], schema_path: Path | None = None) -> list[str]:
    """Return a list of human-readable problems (empty when valid).

    The catalog's top level is checked whole; objects in jobs of 20,000 (in parallel
    processes for large catalogs); relationships by a direct check of their flat shape."""
    schema = json.loads((schema_path or find_schema()).read_text(encoding="utf-8"))
    entities = bundle.get("entities", [])
    edges = bundle.get("edges", [])
    top = {**bundle, "entities": [], "edges": []}
    if not isinstance(entities, list) or not isinstance(edges, list):
        return _schema_errors(bundle, schema)  # wrong shape: let the schema say how
    problems = _schema_errors(top, schema)
    jobs = [
        ({**top, "entities": entities[i : i + _CHUNK]}, schema, i)
        for i in range(0, len(entities), _CHUNK)
    ]
    results: list[list[str]] = []
    if len(entities) >= _PARALLEL_FROM and (os.cpu_count() or 1) > 1:
        try:
            from concurrent.futures import ProcessPoolExecutor

            with ProcessPoolExecutor(max_workers=min(len(jobs), os.cpu_count() or 1)) as pool:
                results = list(pool.map(_entity_job, jobs))
        except (OSError, RuntimeError, ImportError):  # no processes here: one at a time
            results = []
    if not results:
        results = [_entity_job(j) for j in jobs]
    for r in results:
        # The top level was checked already; keep only what is about objects.
        problems.extend(p for p in r if p.startswith("entities/"))
    problems.extend(_check_edges(edges, schema))
    seen: set[str] = set()
    dupes: set[str] = set()
    for e in entities:
        (dupes if e.get("id") in seen else seen).add(e.get("id"))
    problems.extend(f"duplicate entity id: {d}" for d in sorted(dupes))
    return problems


# --- reading / writing ----------------------------------------------------------------

# Catalog files store relationships compactly (``edgeTable``): each object id once, then
# four numbers per relationship (from, to, type, origin) instead of repeating the ids as
# text. A file in this form says schemaVersion 0.2.0, so readers that cannot expand it
# refuse it instead of showing a catalog without relationships. In memory a bundle always
# has the plain ``edges`` list (schema 0.1.x).
COMPACT_VERSION = "0.2.0"


def compact_edges(edges: list[dict[str, Any]]) -> dict[str, Any]:
    ids: dict[str, int] = {}
    types: dict[str, int] = {}
    origins: dict[str, int] = {}
    rows: list[int] = []
    for e in edges:
        o = e.get("origin")
        rows.extend(
            (
                ids.setdefault(e["from"], len(ids)),
                ids.setdefault(e["to"], len(ids)),
                types.setdefault(e["type"], len(types)),
                origins.setdefault(o, len(origins)) if o else -1,
            )
        )
    return {"ids": list(ids), "types": list(types), "origins": list(origins), "rows": rows}


def expand_edges(table: dict[str, Any]) -> list[dict[str, Any]]:
    ids, types, origins, rows = table["ids"], table["types"], table["origins"], table["rows"]
    if len(rows) % 4:
        raise ValueError("edgeTable rows are not groups of four")
    out = []
    for i in range(0, len(rows), 4):
        f, t, ty, o = rows[i : i + 4]
        e = {"from": ids[f], "to": ids[t], "type": types[ty]}
        if o >= 0:
            e["origin"] = origins[o]
        out.append(e)
    return out


def compact_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    """The bundle as it is stored: relationships in an ``edgeTable`` (shallow copy)."""
    if bundle.get("edgeTable") is not None:
        return bundle
    return {
        **bundle,
        "schemaVersion": COMPACT_VERSION,
        "modelVersion": bundle.get("schemaVersion", SCHEMA_VERSION),
        "edges": [],
        "edgeTable": compact_edges(bundle.get("edges") or []),
        # Worked out from this very catalog every time it is written, so a merged,
        # redacted or imported catalog never carries another's.
        "riskTable": risk_table(bundle),
    }


def expand_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    """Turn a stored bundle back into the in-memory form (in place; returns it)."""
    bundle.pop("riskTable", None)  # derived: worked out again whenever the catalog is written
    table = bundle.pop("edgeTable", None)
    if table is not None:
        bundle["edges"] = [*bundle.get("edges", []), *expand_edges(table)]
    # A sharded manifest says 0.2 with its edges in shard files: once read, it is 0.1.
    if "modelVersion" in bundle or str(bundle.get("schemaVersion", "")).startswith("0.2."):
        bundle["schemaVersion"] = bundle.pop("modelVersion", SCHEMA_VERSION)
    return bundle


def supported_version(version: Any) -> bool:
    return str(version or "").startswith(("0.1.", "0.2."))


def write_json(data: Any, out: Any, pretty: bool = False) -> None:
    """Write ``data`` as JSON (plus a newline) to a binary stream a piece at a time.

    Compact output goes through Python's C encoder a thousand list items at a time:
    its streaming encoder (``iterencode``) runs in pure Python, about four times slower
    on large catalogs. The bytes are the same either way."""
    pending: list[str] = []
    size = 0

    def emit(chunk: str) -> None:
        nonlocal pending, size
        pending.append(chunk)
        size += len(chunk)
        if size >= 1 << 20:
            out.write("".join(pending).encode())
            pending, size = [], 0

    if pretty:
        enc = json.JSONEncoder(indent=2, ensure_ascii=False)
        for chunk in enc.iterencode(data):
            emit(chunk)
    else:
        for chunk in _compact_pieces(data, 0):
            emit(chunk)
    pending.append("\n")
    out.write("".join(pending).encode())


_ONE_SHOT = json.JSONEncoder(separators=(",", ":"), ensure_ascii=False)
_ITEMS = 1000


def _compact_pieces(value: Any, depth: int) -> Any:
    """Compact JSON of ``value`` in pieces: the top levels (the bundle, its edge and risk
    tables) member by member, their long lists a thousand items at a time."""
    if depth <= 1 and isinstance(value, dict):
        yield "{"
        for i, (k, v) in enumerate(value.items()):
            yield ("," if i else "") + _ONE_SHOT.encode(str(k)) + ":"
            yield from _compact_pieces(v, depth + 1)
        yield "}"
    elif depth <= 2 and isinstance(value, list) and len(value) > _ITEMS:
        yield "["
        for i in range(0, len(value), _ITEMS):
            yield ("," if i else "") + _ONE_SHOT.encode(value[i : i + _ITEMS])[1:-1]
        yield "]"
    else:
        yield _ONE_SHOT.encode(value)


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
        with out.open("wb") as f:  # streamed: never the whole text in memory
            write_json(compact_bundle(bundle), f, pretty)
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
        body = {"edgeTable": compact_edges(items)} if kind == "edges" else {kind: items}
        data = _dump(body, pretty)
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
    manifest = {
        **bundle,
        "schemaVersion": COMPACT_VERSION,
        "modelVersion": bundle.get("schemaVersion", SCHEMA_VERSION),
        "entities": [],
        "edges": [],
        "riskTable": risk_table(bundle),
        "shards": shards,
    }
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
            body = json.loads(data)
            if "edgeTable" in body:
                bundle[s["kind"]].extend(expand_edges(body["edgeTable"]))
            else:
                bundle[s["kind"]].extend(body[s["kind"]])
    return expand_bundle(bundle)
