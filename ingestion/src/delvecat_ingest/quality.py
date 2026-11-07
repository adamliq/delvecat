"""Data quality checks, evaluated read-only from what the catalog already measured.

Named like OpenMetadata test definitions and run against the sampled field
profile and the health measurements, so they need no extra searches:

* ``fresh``: the newest event is recent (the health freshness check passes).
* ``volume``: yesterday's volume is close to the usual day (health volume check).
* ``notNull``: a field is present in at least ``min`` of sampled events (default 0.95).
* ``distinctBetween``: a field has between ``min`` and ``max`` distinct values.

Built in, without annotations: ``notNull`` for every sourcetype field a
detection reads, plus ``fresh`` and ``volume`` (where they can be judged) on
objects that have other checks; the Health page covers the rest.
Annotations add more with ``qualityChecks`` on any entry (``id`` or ``match``).

Results go to ``entity["quality"]`` (derived; never changes catalog versions).
A check that cannot be judged (field not sampled, no daily history) is
``unknown``, not failed.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

DEFAULT_NOT_NULL = 0.95
HEALTH_TESTS = {"fresh": "freshness", "volume": "volume"}
DESCRIPTIONS = {
    "fresh": "Newest event is recent",
    "volume": "Yesterday's volume is close to the usual day",
}


def _field_name(f: dict[str, Any]) -> str:
    p = f.get("properties") or {}
    return str(p.get("field") or f.get("displayName") or f["name"].rsplit("/", 1)[-1])


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%".replace(".0%", "%")


def _health_test(e: dict[str, Any], test: str) -> tuple[str, str]:
    obs = (e.get("properties") or {}).get("observed") or {}
    if test == "fresh":
        judged = bool(obs.get("lastSeen") or obs.get("latestEvent"))
    else:
        counts = (obs.get("dailyEvents") or {}).get("counts") or []
        judged = len([c for c in counts[:-1] if c > 0]) >= 5
    problem = next(
        (c for c in (e.get("health") or {}).get("checks", []) if c["check"] == HEALTH_TESTS[test]),
        None,
    )
    if problem:
        return "fail", problem["message"]
    if not judged:
        return "unknown", "not measured"
    return "pass", "ok"


def _field_tests(spec: dict[str, Any], fields: list[dict[str, Any]]) -> tuple[str, str, str]:
    """(status, expectation, result) for a field test over one or more field objects."""
    name = spec.get("field", "")
    test = spec["test"]
    matching = [f for f in fields if _field_name(f) == name]
    observed = [((f.get("properties") or {}).get("observed") or {}) for f in matching]
    if test == "notNull":
        floor = float(spec.get("min", DEFAULT_NOT_NULL))
        expectation = f"present in at least {_pct(floor)} of events"
        cover = [o["coverage"] for o in observed if isinstance(o.get("coverage"), (int, float))]
        if not cover:
            return "unknown", expectation, "not sampled"
        worst = min(cover)
        return ("pass" if worst >= floor else "fail"), expectation, f"{_pct(worst)} filled"
    lo, hi = spec.get("min"), spec.get("max")
    expectation = (
        f"{lo if lo is not None else 0} to {hi if hi is not None else '∞'} distinct values"
    )
    counts = [o["distinctCount"] for o in observed if isinstance(o.get("distinctCount"), int)]
    if not counts:
        return "unknown", expectation, "not sampled"
    ok = all((lo is None or c >= lo) and (hi is None or c <= hi) for c in counts)
    return (
        ("pass" if ok else "fail"),
        expectation,
        ", ".join(f"{c:,}" for c in counts) + " distinct",
    )


def apply_quality(bundle: dict[str, Any]) -> dict[str, int]:
    """(Re)compute ``quality`` on every entity that has checks; return counts."""
    entities = bundle["entities"]
    edges = bundle["edges"]
    by_id = {e["id"]: e for e in entities}
    for e in entities:
        e.pop("quality", None)

    fields_of: dict[str, list[dict[str, Any]]] = defaultdict(list)  # sourcetype id -> fields
    feeds: dict[str, list[str]] = defaultdict(list)  # index id -> sourcetype ids
    detections_reading: dict[str, set[str]] = defaultdict(set)  # field id -> detection ids
    for x in edges:
        if x["type"] == "contains" and x["to"].split(":", 2)[1] == "field" and x["to"] in by_id:
            fields_of[x["from"]].append(by_id[x["to"]])
        elif x["type"] == "feeds" and x["from"].split(":", 2)[1] == "sourcetype":
            feeds[x["to"]].append(x["from"])
        elif (
            x["type"] == "readsField"
            and by_id.get(x["from"], {}).get("type") == "correlationSearch"
        ):
            detections_reading[x["to"]].add(x["from"])

    counts = {"objectsChecked": 0, "passed": 0, "failed": 0, "unknown": 0}
    for e in entities:
        if e["type"] not in ("index", "sourcetype"):
            continue
        fields = fields_of.get(e["id"], [])
        if e["type"] == "index":
            fields = [f for st in feeds.get(e["id"], []) for f in fields_of.get(st, [])]
        specs: list[dict[str, Any]] = []
        if e["type"] == "sourcetype":
            for f in fields:
                if detections_reading.get(f["id"]):
                    n = len(detections_reading[f["id"]])
                    specs.append(
                        {
                            "test": "notNull",
                            "field": _field_name(f),
                            "source": "default",
                            "why": f"read by {n} detection{'s' if n != 1 else ''}",
                        }
                    )
        # Freshness and volume complete the picture for data that has other checks,
        # where they can be judged (the Health page covers everything else).
        if specs or (e.get("annotations") or {}).get("qualityChecks"):
            for t in ("fresh", "volume"):
                if _health_test(e, t)[0] != "unknown":
                    specs.append({"test": t, "source": "default"})
        for spec in (e.get("annotations") or {}).get("qualityChecks", []):
            specs = [
                s
                for s in specs
                if not (
                    s["source"] == "default"
                    and (s["test"], s.get("field")) == (spec["test"], spec.get("field"))
                )
            ]
            specs.append(spec)
        if not specs:
            continue
        tests = []
        for spec in specs:
            t = spec["test"]
            if t in HEALTH_TESTS:
                status, result = _health_test(e, t)
                expectation = DESCRIPTIONS[t]
            else:
                status, expectation, result = _field_tests(spec, fields)
            test = {
                "test": t,
                "expectation": expectation,
                "result": result,
                "status": status,
                "source": spec.get("source", "annotation"),
            }
            if spec.get("field"):
                test["field"] = spec["field"]
            if spec.get("why"):
                test["why"] = spec["why"]
            tests.append(test)
        passed = sum(t["status"] == "pass" for t in tests)
        failed = sum(t["status"] == "fail" for t in tests)
        e["quality"] = {"tests": tests, "passed": passed, "failed": failed}
        counts["objectsChecked"] += 1
        counts["passed"] += passed
        counts["failed"] += failed
        counts["unknown"] += len(tests) - passed - failed
    return counts
