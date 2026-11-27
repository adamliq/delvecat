"""Objects at risk, worked out once when a catalog is written (``riskTable``).

The same rules as the web app's ``risk.ts`` (which reads this table instead of working
it out in every browser, seconds on large catalogs): an object is at risk when it
depends, directly or through other objects, on something with a problem (a health
finding, a broken reference, a disabled object, a failing data quality test).

Risk follows dependency: a search depends on the index it reads; a summary index on
the search that writes it; a detection on the alert action it triggers. When a target
has several producers of the same kind (an index fed by many sourcetypes), one bad
producer only partly affects it: a warning there, and the risk goes no further. A
disabled producer there is ignored, since disabling is usually deliberate.

``RULES_VERSION`` must match ``RISK_RULES_VERSION`` in risk.ts: when the rules change,
both change, and a web app reading an older table works the risk out itself.
"""

from __future__ import annotations

from typing import Any

RULES_VERSION = 1
MAX_DEPTH = 10

FROM_NEEDS_TO = {"reads", "uses", "mapsTo", "triggers", "readsField"}
TO_NEEDS_FROM = {"definesField", "feeds", "writes", "accelerates", "deploys"}


def _problems(e: dict[str, Any]) -> tuple[bool, bool, bool]:
    """(has problems, any critical, only "disabled")."""
    kinds: list[str] = []
    critical = False
    for c in (e.get("health") or {}).get("checks") or []:
        if c.get("status") != "ok":
            kinds.append("health")
            critical |= c.get("status") == "critical"
    if (e.get("lineage") or {}).get("unresolved") or []:
        kinds.append("brokenReference")
    if e.get("disabled"):
        kinds.append("disabled")
    for t in (e.get("quality") or {}).get("tests") or []:
        # Freshness and volume failures are already health findings.
        if t.get("status") == "fail" and t.get("test") not in ("fresh", "volume"):
            kinds.append("quality")
    return bool(kinds), critical, bool(kinds) and all(k == "disabled" for k in kinds)


def risk_table(bundle: dict[str, Any]) -> dict[str, Any]:
    """Every at-risk object with what puts it at risk, compactly: ``ids`` once, then for
    each at-risk object [object, severity (1 critical, 0 warning), number of causes]
    followed by four numbers per cause [root, depth, via (-1 when direct), partial]."""
    entities = bundle["entities"]
    by_id = {e["id"]: e for e in entities}
    dependents: dict[str, list[tuple[str, str | None]]] = {}
    producers: dict[str, int] = {}
    for x in bundle["edges"]:
        t = x["type"]
        if t in FROM_NEEDS_TO:
            dep, on, key = x["from"], x["to"], None
        elif t in TO_NEEDS_FROM:
            key = f"{x['to']}|{t}"
            producers[key] = producers.get(key, 0) + 1
            dep, on = x["to"], x["from"]
        else:
            continue
        if dep != on:
            dependents.setdefault(on, []).append((dep, key))

    def shared(key: str | None) -> bool:
        return key is not None and producers.get(key, 0) > 1

    at_risk: dict[str, list[Any]] = {}  # id -> [critical, causes]
    for root in entities:
        rid = root["id"]
        bad, critical, only_disabled = _problems(root)
        if not bad or rid not in dependents:
            continue
        seen = {rid}
        frontier = [rid]
        for depth in range(1, MAX_DEPTH + 1):
            if not frontier:
                break
            nxt: list[str] = []
            for oid in frontier:
                for dep, key in dependents.get(oid, ()):
                    if dep in seen:
                        continue
                    partial = shared(key)
                    if partial and only_disabled:
                        continue
                    seen.add(dep)
                    entity = by_id.get(dep)
                    # A disabled object is a cause in its own right; nothing runs through it.
                    if entity is None or entity.get("disabled"):
                        continue
                    level_critical = critical and not partial
                    r = at_risk.get(dep)
                    if r is None:
                        r = at_risk[dep] = [level_critical, []]
                    else:
                        r[0] = r[0] or level_critical
                    r[1].append((rid, depth, oid if depth > 1 else None, partial))
                    if not partial:
                        nxt.append(dep)
            frontier = nxt

    ids: dict[str, int] = {}

    def at(i: str) -> int:
        return ids.setdefault(i, len(ids))

    rows: list[int] = []
    for dep, (crit, causes) in at_risk.items():
        rows.extend((at(dep), 1 if crit else 0, len(causes)))
        for rid, depth, via, partial in causes:
            rows.extend((at(rid), depth, at(via) if via is not None else -1, 1 if partial else 0))
    return {"version": RULES_VERSION, "ids": list(ids), "rows": rows}
