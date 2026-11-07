"""Governance: where sensitive data lives and who can reach it.

1. **Effective classifications.** A classification annotated on a field also
   applies to its sourcetype; on a sourcetype, to the indexes it feeds. From any
   classified data store it is carried along lineage to the data stores derived
   from it (summary indexes, lookups written by searches, indexes fed by DB
   Connect from a classified table), marked ``derived``. Searches and dashboards
   that read classified data directly are marked as consumers.
2. **Access.** A role reaches an index through its effective search access
   (``grantsAccess``, inherited roles included) and a lookup / KV collection
   through the object's read permission (``*`` = every role). Users inherit
   their roles' access. Row-level search filters are reported, not evaluated.

Results go to ``entity["governance"]`` (derived; never changes catalog versions).
Approximations: app-level visibility of objects and capabilities such as
``admin_all_objects`` are not modelled.
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

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
FLOW_FORWARD = {"feeds", "writes", "triggers", "accelerates", "deploys"}
FLOW_REVERSE = {"reads", "uses", "mapsTo"}
MAX_DEPTH = 6
DEFAULT_ROLES = frozenset({"user"})  # granted to new users by default


def _taxonomy(bundle: dict[str, Any]):
    defs = {c["name"]: c for c in bundle.get("classifications") or []}

    def lookup(name: str) -> dict[str, Any]:
        parts = name.split(".")
        for i in range(len(parts), 0, -1):
            if (d := defs.get(".".join(parts[:i]))) is not None:
                return d
        return {}

    def sensitive(name: str) -> bool:
        return lookup(name).get("sensitive", True)

    def propagates(name: str) -> bool:
        return lookup(name).get("propagate", True)

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

    # structural: field -> sourcetype -> index
    out_edges: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in edges:
        out_edges[edge["from"]].append(edge)
    contains_field = {
        edge["to"]: edge["from"]
        for edge in edges
        if edge["type"] == "contains" and edge["to"].split(":")[1] == "field"
    }
    for fid, st in contains_field.items():
        for c in list(found.get(fid, {})):
            add(st, c, fid, False, "field")
    for e in [x for x in entities if x["type"] == "sourcetype"]:
        for c in list(found.get(e["id"], {})):
            for edge in out_edges[e["id"]]:
                if edge["type"] == "feeds" and edge["to"].split(":")[1] == "index":
                    add(edge["to"], c, e["id"], False, "sourcetype")

    # lineage: carry to derived data stores; mark direct consumers
    down: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge["type"] in FLOW_FORWARD:
            down[edge["from"]].append(edge["to"])
        elif edge["type"] in FLOW_REVERSE:
            down[edge["to"]].append(edge["from"])
    consumers: dict[str, set[str]] = defaultdict(set)
    seeds = [(eid, c) for eid, cs in list(found.items()) for c in cs if propagates(c)]
    for origin, cls in seeds:
        queue: deque[tuple[str, int]] = deque([(origin, 0)])
        seen = {origin}
        while queue:
            node, depth = queue.popleft()
            if depth >= MAX_DEPTH:
                continue
            for nxt in down.get(node, []):
                if nxt in seen or nxt not in by_id:
                    continue
                seen.add(nxt)
                t = by_id[nxt]["type"]
                if t in CONSUMER_TYPES and depth == 0:
                    consumers[nxt].add(cls)
                if t in STORE_TYPES and t != "field":
                    add(nxt, cls, origin, True, "lineage")
                queue.append((nxt, depth + 1))

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

    def sensitive_classes(eid: str) -> list[str]:
        return sorted(c for c in found.get(eid, {}) if sensitive(c))

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
        for e in entities:
            if e["type"] not in ("lookup", "kvCollection") or not (
                cls := sensitive_classes(e["id"])
            ):
                continue
            readers = set((e.get("permissions") or {}).get("read", []))
            if "*" in readers or readers & names:
                role_access[rid].append({"id": e["id"], "classifications": cls, "how": "read"})
                store_access[e["id"]].append({"role": rid, "filtered": False})

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
    for u in [e for e in entities if e["type"] == "user"]:
        held = {edge["to"] for edge in out_edges[u["id"]] if edge["type"] == "memberOf"}
        reach: dict[str, dict[str, Any]] = {}
        for rid in held:
            for a in role_access.get(rid, []):
                item = reach.setdefault(a["id"], {**a, "viaRoles": []})
                item["viaRoles"].append(rid)
        if reach:
            u.setdefault("governance", {})["sensitiveAccess"] = sorted(
                reach.values(), key=lambda a: a["id"]
            )

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
