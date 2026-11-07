"""Governance: where sensitive data lives and who can reach it.

1. **Effective classifications.** A classification annotated on a field also
   applies to fields derived from it (aliases, calculated fields, lookups), to
   its sourcetype and to the indexes it feeds, in that column. From there it
   is carried along lineage column by column (see :mod:`classify`): a search
   passes it on only through result columns computed from a classified column,
   counts and hashes pass nothing on, and ``stopsClassifications`` stops it.
   Derived classifications record the columns that hold them and the object
   they came through. Searches and dashboards that use a classified column
   are marked as reading it.
2. **Access.** A role reaches an index through its effective search access
   (``grantsAccess``, inherited roles included) and a lookup / KV collection
   through the object's read permission (``*`` = every role). Users inherit
   their roles' access. Row-level search filters are reported, not evaluated.

Results go to ``entity["governance"]`` (derived; never changes catalog versions).
Approximations: app-level visibility of objects and capabilities such as
``admin_all_objects`` are not modelled.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .classify import ALL, derived_fields, propagate

STORE_TYPES = frozenset(
    {"index", "sourcetype", "lookup", "kvCollection", "externalTable", "dataModel", "field"}
)
CONSUMER_TYPES = frozenset(
    {
        "savedSearch",
        "correlationSearch",
        "dashboard",
        "dbOutput",
        "uebaDataSource",
        "workflowAction",
    }
)
DEFAULT_ROLES = frozenset({"user"})  # granted to new users by default


def _taxonomy(bundle: dict[str, Any]):
    defs = {c["name"]: c for c in bundle.get("classifications") or []}

    def lookup(name: str) -> dict[str, Any]:
        parts = name.split(".")
        for i in range(len(parts), 0, -1):
            if (d := defs.get(".".join(parts[:i]))) is not None:
                return d
        return {}

    cache: dict[str, dict[str, Any]] = {}

    def cached(name: str) -> dict[str, Any]:
        if name not in cache:
            cache[name] = lookup(name)
        return cache[name]

    def sensitive(name: str) -> bool:
        return cached(name).get("sensitive", True)

    def propagates(name: str) -> bool:
        return cached(name).get("propagate", True)

    return sensitive, propagates


def apply_governance(bundle: dict[str, Any]) -> dict[str, Any]:
    entities = bundle["entities"]
    edges = bundle["edges"]
    by_id = {e["id"]: e for e in entities}
    sensitive, propagates = _taxonomy(bundle)
    for e in entities:
        e.pop("governance", None)

    # effective classifications: id -> {classification: provenance}
    found: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)

    def add(eid: str, cls: str, via: str | None, derived: bool, how: str) -> bool:
        if eid not in by_id or cls in found[eid]:
            return False
        found[eid][cls] = {"via": via, "derived": derived, "how": how}
        return True

    for e in entities:
        for c in (e.get("annotations") or {}).get("classifications", []):
            add(e["id"], c, None, False, "annotated")

    # fields derived from classified fields (aliases, calculated fields, lookups)
    sources = derived_fields(by_id, edges)
    changed = True
    while changed:
        changed = False
        for fid, srcs in sources.items():
            for src in sorted(srcs):
                for c in list(found.get(src, {})):
                    changed |= add(fid, c, src, True, "derivedField")

    # columns each classification is in: node -> class -> names (ALL = every column)
    seed_cols: dict[str, dict[str, frozenset[str] | None]] = defaultdict(dict)
    for eid, cs in found.items():
        if by_id[eid]["type"] != "field":
            for c in cs:
                seed_cols[eid][c] = ALL

    # structural: field -> sourcetype -> index
    out_edges: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in edges:
        out_edges[edge["from"]].append(edge)
    contains_field = {
        edge["to"]: edge["from"]
        for edge in edges
        if edge["type"] == "contains" and edge["to"].split(":")[1] == "field"
    }

    def field_name(fid: str) -> str:
        p = by_id[fid].get("properties") or {}
        return str(p.get("field") or by_id[fid].get("displayName") or fid.rsplit("/", 1)[-1])

    for fid, st in contains_field.items():
        for c in list(found.get(fid, {})):
            add(st, c, fid, False, "field")
            cur = seed_cols[st].get(c, frozenset())
            if cur is not ALL:
                seed_cols[st][c] = cur | {field_name(fid)}
    for e in [x for x in entities if x["type"] == "sourcetype"]:
        for c in list(found.get(e["id"], {})):
            for edge in out_edges[e["id"]]:
                if edge["type"] == "feeds" and edge["to"].split(":")[1] == "index":
                    add(edge["to"], c, e["id"], False, "sourcetype")
                    cur = seed_cols[edge["to"]].get(c, frozenset())
                    st_cols = seed_cols[e["id"]].get(c, ALL)
                    seed_cols[edge["to"]][c] = (
                        ALL if cur is ALL or st_cols is ALL else cur | st_cols
                    )

    # lineage: carry classifications to derived data through the columns that hold them
    carried = {c for cs in found.values() for c in cs if propagates(c)}
    derived, readers, stopped = propagate(by_id, edges, seed_cols, carried)
    for node, per in derived.items():
        if by_id[node]["type"] in STORE_TYPES and by_id[node]["type"] != "field":
            for c, d in sorted(per.items()):
                if add(node, c, d["via"], True, "lineage") and d["columns"] is not ALL:
                    found[node][c]["columns"] = sorted(d["columns"])
    for node, per in seed_cols.items():
        for c, cols in per.items():
            if cols is not ALL and c in found.get(node, {}):
                found[node][c].setdefault("columns", sorted(cols))
    consumers: dict[str, set[str]] = defaultdict(set)
    for node, cls in readers.items():
        if by_id[node]["type"] in CONSUMER_TYPES:
            consumers[node] |= cls

    # field lineage: a search that reads a classified field reads that classification
    for edge in edges:
        if edge["type"] == "readsField" and edge["from"] in by_id:
            for c in found.get(edge["to"], {}):
                if by_id[edge["from"]]["type"] in CONSUMER_TYPES:
                    consumers[edge["from"]].add(c)

    # role closure (role -> itself + imported roles, transitively)
    imports: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge["type"] == "inherits":
            imports[edge["from"]].add(edge["to"])
    roles = [e for e in entities if e["type"] == "role"]
    role_names = {e["id"]: e["name"] for e in roles}

    def closure(rid: str) -> set[str]:
        out, stack = set(), [rid]
        while stack:
            r = stack.pop()
            if r not in out:
                out.add(r)
                stack.extend(imports.get(r, ()))
        return out

    role_closure = {r["id"]: closure(r["id"]) for r in roles}
    grants: dict[str, set[str]] = defaultdict(set)  # role id -> index ids it can search
    for edge in edges:
        if edge["type"] == "grantsAccess":
            grants[edge["from"]].add(edge["to"])

    sensitive_cache: dict[str, list[str]] = {}

    def sensitive_classes(eid: str) -> list[str]:
        if eid not in sensitive_cache:
            sensitive_cache[eid] = sorted(c for c in found.get(eid, {}) if sensitive(c))
        return sensitive_cache[eid]

    # Classified lookups and KV collections with their readers, found once (not per role).
    readable_stores = [
        (e["id"], cls, set((e.get("permissions") or {}).get("read", [])))
        for e in entities
        if e["type"] in ("lookup", "kvCollection") and (cls := sensitive_classes(e["id"]))
    ]

    # access to sensitive stores
    store_access: dict[str, list[dict[str, Any]]] = defaultdict(list)
    role_access: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in roles:
        rid = r["id"]
        names = {role_names.get(x, x.rsplit(":", 1)[-1]) for x in role_closure[rid]}
        search_filter = str((r.get("properties") or {}).get("srchFilter") or "").strip()
        filtered = search_filter not in ("", "*")  # "*" places no restriction
        for idx in sorted(grants.get(rid, ())):
            if cls := sensitive_classes(idx):
                entry = {"id": idx, "classifications": cls, "how": "search", "filtered": filtered}
                role_access[rid].append(entry)
                store_access[idx].append({"role": rid, "filtered": filtered})
        for sid, cls, readers in readable_stores:
            if "*" in readers or readers & names:
                role_access[rid].append({"id": sid, "classifications": cls, "how": "read"})
                store_access[sid].append({"role": rid, "filtered": False})

    members: dict[str, set[str]] = defaultdict(set)  # role id -> user ids
    for edge in edges:
        if edge["type"] == "memberOf":
            members[edge["to"]].add(edge["from"])

    def users_of(role_ids: set[str]) -> set[str]:
        """Users holding any of the roles directly or through roles that import them."""
        out: set[str] = set()
        for rid, cl in role_closure.items():
            if cl & role_ids:
                out |= members.get(rid, set())
        return out

    # write results
    for eid, cs in found.items():
        gov = by_id[eid].setdefault("governance", {})
        gov["classifications"] = [
            {"name": c, **prov, "sensitive": sensitive(c)} for c, prov in sorted(cs.items())
        ]
    for eid, cls in consumers.items():
        by_id[eid].setdefault("governance", {})["readsClassified"] = sorted(cls)
    for eid, cls in stopped.items():
        by_id[eid].setdefault("governance", {})["stops"] = sorted(cls)
    for eid, access in store_access.items():
        role_ids = {a["role"] for a in access}
        everyone = "*" in set((by_id[eid].get("permissions") or {}).get("read", [])) or any(
            role_names.get(r) in DEFAULT_ROLES for r in role_ids
        )
        by_id[eid].setdefault("governance", {})["access"] = {
            "roles": sorted(role_ids),
            "filteredRoles": sorted({a["role"] for a in access if a["filtered"]}),
            "users": sorted(users_of(role_ids)),
            "everyone": everyone,
        }
    for rid, access in role_access.items():
        by_id[rid].setdefault("governance", {})["sensitiveAccess"] = access
    # A user's reach is the union of their roles' (which already include inherited
    # roles). It is not copied onto every user: on large estates that duplicated most
    # of the bundle. The web app derives it from the roles.
    for u in [e for e in entities if e["type"] == "user"]:
        gov = u.get("governance")
        if gov is not None:
            gov.pop("sensitiveAccess", None)
            if not gov:
                u.pop("governance")

    summary = {
        "classifiedObjects": len(found),
        "sensitiveStores": sum(
            1 for eid in found if sensitive_classes(eid) and by_id[eid]["type"] in STORE_TYPES
        ),
        "exposedToEveryone": sum(
            1 for e in entities if (e.get("governance") or {}).get("access", {}).get("everyone")
        ),
    }
    reports = [r for r in bundle.get("ingestionReport", []) if r["connector"] != "governance"]
    bundle["ingestionReport"] = [
        *reports,
        {"connector": "governance", "status": "ok", "counts": summary},
    ]
    return summary
