import json
from pathlib import Path

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.connectors import splunk
from delvecat_ingest.cron import runs_per_day
from delvecat_ingest.health import apply_usage, evaluate_health, mark_unused
from delvecat_ingest.model import entity
from delvecat_ingest.transport import FixtureTransport

RECORDED = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
AS_OF = "2026-11-06T12:00:00Z"


@pytest.mark.parametrize(
    "cron,expected",
    [
        ("*/15 * * * *", 96),
        ("5 * * * *", 24),
        ("0 3 * * *", 1),
        ("0 3 * * 1", 1 / 7),
        ("0 9-17 * * 1-5", 9 * 5 / 7),
        ("0,30 * 1 * *", 48 / 30.4),
        ("bad", None),
        (None, None),
    ],
)
def test_cron_runs_per_day(cron, expected):
    got = runs_per_day(cron)
    assert got == pytest.approx(expected) if expected is not None else got is None


def idx(name, **observed):
    return entity(id=f"i:index:{name}", type="index", name=name, instance="i", observed=observed)


def checks(e):
    return [(c["check"], c["status"]) for c in (e.get("health") or {}).get("checks", [])]


def test_freshness_volume_delay_and_parsing():
    fresh = idx("fresh", totalEventCount=10, latestEvent="2026-11-06T11:00:00Z")
    stale = idx("stale", totalEventCount=10, latestEvent="2026-11-04T12:00:00Z")
    dead = idx("dead", totalEventCount=10, latestEvent="2026-10-01T00:00:00Z")
    empty = idx("empty", totalEventCount=0, latestEvent="2026-10-01T00:00:00Z")
    drop = idx(
        "drop",
        totalEventCount=10,
        latestEvent="2026-11-06T11:00:00Z",
        dailyEvents={"start": "2026-10-30", "counts": [100, 110, 90, 105, 95, 10, 4]},
    )
    short = idx(
        "short",
        totalEventCount=10,
        latestEvent="2026-11-06T11:00:00Z",
        dailyEvents={"start": "2026-11-04", "counts": [100, 1, 0]},
    )
    st = entity(
        id="i:sourcetype:x",
        type="sourcetype",
        name="x",
        instance="i",
        observed={
            "eventCount": 5,
            "lastSeen": "2026-11-06T11:59:00Z",
            "ingestDelaySecs": 4000,
            "parsingWarnings": {"DateParserVerbose": 3},
        },
    )
    stash = entity(
        id="i:sourcetype:stash",
        type="sourcetype",
        name="stash",
        instance="i",
        observed={"eventCount": 5, "ingestDelaySecs": 9999},
    )
    off = idx("off", totalEventCount=10, latestEvent="2026-01-01T00:00:00Z")
    off["disabled"] = True
    ents = [fresh, stale, dead, empty, drop, short, st, stash, off]
    evaluate_health(ents, AS_OF)
    assert checks(fresh) == [] and "health" not in fresh
    assert checks(stale) == [("freshness", "warning")]
    assert checks(dead) == [("freshness", "critical")]
    assert checks(empty) == []  # never had data: not "stale"
    assert checks(drop) == [("volume", "warning")]
    assert checks(short) == []  # not enough history to judge
    assert checks(st) == [("ingestDelay", "critical"), ("parsing", "warning")]
    assert checks(stash) == []  # summary data is delayed by design
    assert "health" not in off
    assert drop["health"]["status"] == "warning" and dead["health"]["status"] == "critical"


def search(name, cron="*/15 * * * *", scheduled=True, **usage):
    e = entity(
        id=f"i:savedSearch:a/{name}",
        type="savedSearch",
        name=name,
        instance="i",
        app="a",
        sharing="app",
        properties={"isScheduled": scheduled, "cronSchedule": cron},
    )
    if usage:
        e["usage"] = usage
    return e


def test_scheduler_checks():
    skipping = search("skip", scheduler={"total": 10, "skipped": 6, "lastSkipReason": "quota"})
    some = search("some", scheduler={"total": 10, "skipped": 2})
    slow = search("slow", scheduler={"total": 4, "maxRuntimeSecs": 900, "failed": 1})
    silent = search("silent")
    weekly = search("weekly", cron="0 3 * * 1")
    ents = [skipping, some, slow, silent, weekly]
    evaluate_health(ents, AS_OF, "2026-11-06T00:00:00Z")  # scheduler log covers 12 hours
    assert checks(skipping) == [("skipped", "critical")]
    assert "quota" in skipping["health"]["checks"][0]["message"]
    assert checks(some) == [("skipped", "warning")]
    assert checks(slow) == [("failed", "warning"), ("runtime", "warning")]
    assert checks(silent) == [("notRunning", "warning")]
    assert checks(weekly) == []  # not due yet within the covered period
    evaluate_health([search("silent2")], AS_OF, None)  # no scheduler data: do not judge


def test_usage_matching_and_unused_rules():
    used_macro = entity(
        id="i:macro:a/m",
        type="macro",
        name="m",
        instance="i",
        app="a",
        sharing="app",
        properties={"definition": "index=web"},
    )
    lonely = entity(
        id="i:macro:a/lonely",
        type="macro",
        name="lonely",
        instance="i",
        app="a",
        sharing="app",
        properties={"definition": "x"},
    )
    fed = entity(id="i:lookup:a/l", type="lookup", name="l", instance="i", app="a", sharing="app")
    web = idx("web", totalEventCount=5)
    empty = idx("empty", totalEventCount=0)
    adhoc = search("adhoc", scheduled=False)
    dash = entity(id="i:dashboard:a/d", type="dashboard", name="d", instance="i", app="a")
    user = entity(id="i:user:bo", type="user", name="bo", instance="i")
    builtin_app = entity(
        id="i:app:splunk_x",
        type="app",
        name="splunk_x",
        instance="i",
        properties={"author": "Splunk"},
    )
    stock = entity(
        id="i:macro:splunk_x/stock",
        type="macro",
        name="stock",
        instance="i",
        app="splunk_x",
        sharing="app",
        properties={"definition": "x"},
    )
    ents = [used_macro, lonely, fed, web, empty, adhoc, dash, user, builtin_app, stock]
    apply_usage(
        ents,
        [
            {"types": ["savedSearch"], "name": "adhoc", "app": "a", "usage": {"runs": 3}},
            {"types": ["dashboard"], "name": "d", "app": "other", "usage": {"views": 9}},
        ],
        [
            {
                "app": "a",
                "search": "`m` | stats count | lookup l x",
                "runs": 4,
                "lastUsed": "2026-11-05T00:00:00Z",
                "dashboard": None,
            },
            {
                "app": "a",
                "search": "index=* | stats count",
                "runs": 100,
                "lastUsed": None,
                "dashboard": None,
            },
        ],
    )
    assert used_macro["usage"]["adhocSearches"] == 4
    assert fed["usage"]["adhocSearches"] == 4
    assert web["usage"]["adhocSearches"] == 4  # via macro m; "index=*" is not counted
    assert "usage" not in dash  # the view was in another app
    dest = idx("summary", totalEventCount=0)
    ents.append(dest)
    edges = [{"from": "i:savedSearch:a/adhoc", "to": "i:index:summary", "type": "writes"}]
    n = mark_unused(
        ents, edges, {"usageSavedSearches", "usageAdhocSearches", "usageDashboardViews"}
    )
    unused = {e["name"]: e["usage"] for e in ents if (e.get("usage") or {}).get("unused")}
    assert set(unused) == {"lonely", "empty", "d", "bo", "stock"}
    assert unused["stock"].get("builtin") is True and not unused["lonely"].get("builtin")
    assert n == 5


def test_unused_needs_usage_data():
    lonely = entity(id="i:macro:a/x", type="macro", name="x", instance="i", app="a")
    assert mark_unused([lonely], [], available=set()) == 0  # no audit data: no verdict


def test_recorded_instance_is_judged_as_of_its_recording(tmp_path):
    t = FixtureTransport(RECORDED)
    result = splunk.extract(t, "dev")
    assert result.as_of == json.loads((RECORDED / "__meta__.json").read_text())["recordedAt"]
    b = assemble([{"id": "dev", "name": "dev", "kind": "splunkEnterprise"}], result)
    assert validate(b) == []
    by = {e["id"]: e for e in b["entities"]}
    blind = by["dev:correlationSearch:DA-ESS-ContentUpdate/ESCU - Suspicious PowerShell Execution"]
    assert checks(blind) == [("notRunning", "warning")]
    rare = by["dev:savedSearch:acme_secops/Firewall - Denied Outbound to Rare Ports"]
    assert rare["usage"]["scheduler"]["success"] >= 1 and "health" not in rare
    assert by["dev:macro:acme_web/web_status_buckets"]["usage"]["adhocSearches"] >= 1
    assert by["dev:user:jlee"]["usage"]["unused"] is True
    assert by["dev:index:web"]["properties"]["observed"]["dailyEvents"]["counts"]
    report = next(r for r in b["ingestionReport"] if r["connector"] == "health")
    assert report["message"].startswith("as of 2026-")
    # the recording time, not "now", decides freshness
    assert not any(
        c["check"] == "freshness"
        for e in b["entities"]
        for c in (e.get("health") or {}).get("checks", [])
    )
