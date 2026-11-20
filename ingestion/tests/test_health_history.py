"""Health over time: daily scheduler and alert series, thresholds in the report, and
what changed since the previous build (first seen, resolved, trend)."""

from __future__ import annotations

import copy
from pathlib import Path

from delvecat_ingest.health import HISTORY_POINTS, apply_health_history, thresholds
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
BRUTE = "acme:correlationSearch:DA-ESS-ContentUpdate/ESCU - Brute Force Access Behavior Detected"
FIREWALL = "acme:savedSearch:acme_secops/Firewall - Denied Outbound to Rare Ports"


class Rows(FixtureTransport):
    def __init__(self, name, rows):
        super().__init__(FIXTURE)
        self.name, self.rows = name, rows

    def search(self, name, spl, earliest="-24h", latest="now"):
        if name == self.name:
            return self.rows
        return super().search(name, spl, earliest, latest)


def _bundle(transport=None, previous=None):
    return build_here(transport or FixtureTransport(FIXTURE), "acme", previous=previous)


def _by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def test_report_lists_the_thresholds_used():
    report = next(r for r in _bundle()["ingestionReport"] if r["connector"] == "health")
    assert report["thresholds"] == thresholds()
    assert report["thresholds"]["staleWarningHours"] == 24


def test_scheduler_days_are_summed_and_kept_per_day():
    day = 86400
    rows = [
        {
            "app": "acme_secops",
            "savedsearch_name": "Firewall - Denied Outbound to Rare Ports",
            "user": "admin",
            "_time": str(t),
            "total": str(n),
            "success": str(n - s - f),
            "skipped": str(s),
            "failed": str(f),
            "continued": "0",
            "avgRuntime": str(rt),
            "maxRuntime": str(rt),
            "first": str(t + 60),
            "last": str(t + 3600),
            "lastReason": why,
        }
        for t, n, s, f, rt, why in [
            (1793836800, 10, 0, 0, 1.0, ""),
            (1793836800 + 2 * day, 10, 6, 1, 3.0, "too many concurrent searches"),
        ]
    ]
    u = _by_id(_bundle(Rows("health_scheduler", rows)))[FIREWALL]["usage"]["scheduler"]
    assert (u["total"], u["skipped"], u["failed"], u["success"]) == (20, 6, 1, 13)
    assert u["avgRuntimeSecs"] == 2.0 and u["maxRuntimeSecs"] == 3.0
    assert u["lastSkipReason"] == "too many concurrent searches"
    # Every day from the first to the last, quiet days as 0.
    assert u["daily"] == {"start": "2026-11-05", "runs": [10, 0, 10], "problems": [0, 0, 7]}


def test_alert_fires_per_day():
    by_id = _by_id(_bundle())
    daily = by_id[BRUTE]["usage"]["alertDaily"]
    assert sum(daily["counts"]) == by_id[BRUTE]["usage"]["alertFires"] == 1500
    assert len(daily["counts"]) == 30
    # Older recordings without days: totals only.
    rows = [
        {
            "ssApp": "acme_secops",
            "name": "Firewall - Denied Outbound to Rare Ports",
            "schedFired": "3",
            "suppressed": "1",
            "auditFired": "0",
            "last": "1793900000",
        }
    ]
    u = _by_id(_bundle(Rows("usage_alert_fires", rows)))[FIREWALL]["usage"]
    assert u["alertFires"] == 3 and "alertDaily" not in u


def _findings(bundle):
    return {
        (e["id"], c["check"]): c
        for e in bundle["entities"]
        for c in (e.get("health") or {}).get("checks", [])
    }


def test_first_build_starts_the_trend():
    b = _bundle()
    assert len(b["healthHistory"]) == 1
    point = b["healthHistory"][0]
    assert point["at"] == b["generatedAt"] and point["findings"] == len(_findings(b))
    assert all(c["since"] == b["generatedAt"] for c in _findings(b).values())
    assert "resolvedFindings" not in b


def test_since_resolved_and_trend_against_the_previous_build():
    first = _bundle()
    previous = copy.deepcopy(first)
    previous["generatedAt"] = "2026-10-01T00:00:00Z"
    previous["healthHistory"] = [{**first["healthHistory"][0], "at": "2026-10-01T00:00:00Z"}]
    for c in _findings(previous).values():
        c["since"] = "2026-09-01T00:00:00Z"
    # An extra finding the previous build had on an object that is still there, one on an
    # object that is gone.
    still = next(e for e in previous["entities"] if e["id"] == FIREWALL)
    still.setdefault("health", {"status": "warning", "checks": []})["checks"].append(
        {"check": "skipped", "status": "warning", "message": "Skipped 3 of 10 runs"}
    )
    previous["entities"].append(
        {
            "id": "acme:index:acme:gone",
            "type": "index",
            "name": "gone",
            "health": {
                "status": "critical",
                "checks": [
                    {"check": "freshness", "status": "critical", "message": "No data for 9 days"}
                ],
            },
        }
    )
    b = _bundle(previous=previous)
    # Findings that were there keep their first-seen time.
    assert {c["since"] for c in _findings(b).values()} == {"2026-09-01T00:00:00Z"}
    resolved = {(r["id"], r["check"]): r for r in b["resolvedFindings"]}
    assert resolved[(FIREWALL, "skipped")]["how"] == "fixed"
    assert resolved[("acme:index:acme:gone", "freshness")]["how"] == "removed"
    assert resolved[("acme:index:acme:gone", "freshness")]["status"] == "critical"
    assert [h["at"] for h in b["healthHistory"]] == ["2026-10-01T00:00:00Z", b["generatedAt"]]


def test_catalog_from_before_trends_seeds_one_point():
    previous = _bundle()
    previous["generatedAt"] = "2026-10-01T00:00:00Z"
    previous.pop("healthHistory")
    b = _bundle(previous=previous)
    assert [h["at"] for h in b["healthHistory"]] == ["2026-10-01T00:00:00Z", b["generatedAt"]]


def test_trend_is_capped():
    bundle = {"entities": [], "generatedAt": "2026-11-20T00:00:00Z"}
    previous = {
        "entities": [],
        "generatedAt": "2026-11-19T00:00:00Z",
        "healthHistory": [
            {"at": f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z", "critical": 0, "warning": 0}
            for i in range(HISTORY_POINTS + 5)
        ],
    }
    apply_health_history(bundle, previous, bundle["generatedAt"])
    assert len(bundle["healthHistory"]) == HISTORY_POINTS
    assert bundle["healthHistory"][-1]["at"] == "2026-11-20T00:00:00Z"


def test_redaction_renames_resolved_findings():
    bundle = {
        "entities": [{"id": "acme:user:alice", "type": "user", "name": "alice"}],
        "edges": [],
        "instances": [],
        "resolvedFindings": [
            {
                "id": "acme:user:bob",
                "type": "user",
                "name": "bob",
                "check": "x",
                "status": "warning",
                "message": "from 10.1.2.3",
            },
            {
                "id": "acme:index:main",
                "type": "index",
                "name": "main",
                "check": "freshness",
                "status": "warning",
                "message": "stale",
            },
        ],
        "changes": {
            "previousGeneratedAt": "x",
            "added": [],
            "modified": [],
            "removed": [{"id": "acme:user:carol", "type": "user", "name": "carol"}],
        },
    }
    redact_bundle(bundle, load_profile("public"), salt="s")
    names = [r["name"] for r in bundle["resolvedFindings"]]
    assert names[0] != "bob" and names[1] == "main"
    assert "10.1.2.3" not in bundle["resolvedFindings"][0]["message"]
    assert bundle["changes"]["removed"][0]["name"] != "carol"


def test_a_build_without_health_keeps_the_trend_and_the_next_one_compares_nothing():
    full = _bundle()
    full["generatedAt"] = "2026-10-01T00:00:00Z"
    full["healthHistory"][0]["at"] = "2026-10-01T00:00:00Z"
    partial = build_here(
        FixtureTransport(FIXTURE), "acme", parts={"serverInfo", "apps"}, previous=full
    )
    assert partial["healthHistory"] == full["healthHistory"]
    after = _bundle(previous=partial)
    assert [h["at"] for h in after["healthHistory"]] == [
        "2026-10-01T00:00:00Z",
        after["generatedAt"],
    ]
    # No findings to compare with: none is "new" (no first-seen time), none "resolved".
    assert all("since" not in c for c in _findings(after).values())
    assert "resolvedFindings" not in after
