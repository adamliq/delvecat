"""Enterprise Security triage configuration: review statuses, suppressions, and ES 8
Mission Control finding aggregation/suppression rules, automation rules, queues and
configured SOAR apps."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.connectors.enterprise_security import _mc_items, suppression_scope
from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import EndpointNotFound, FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
BRUTE = "acme:correlationSearch:DA-ESS-ContentUpdate/ESCU - Brute Force Access Behavior Detected"


def _build(transport=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme")
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def _checks(e):
    return {c["check"]: c["message"] for c in (e.get("health") or {}).get("checks", [])}


def test_review_statuses():
    _, by_id, _ = _build()
    closed = by_id["acme:esReviewStatus:5"]
    assert closed["displayName"] == "Closed" and closed["product"] == "enterpriseSecurity"
    assert closed["properties"] == {
        "statusType": "notable",
        "default": False,
        "closes": True,
        "hidden": False,
    }
    assert by_id["acme:esReviewStatus:1"]["properties"]["default"] is True
    assert by_id["acme:esReviewStatus:6"]["disabled"] is True


def test_suppression_scope():
    s = suppression_scope('source="A - Rule" src=1.2.3.4 _time>=1790000000 _time<1790086400')
    assert s["detections"] == ["A - Rule"] and s["conditions"] is True
    assert s["start"].startswith("2026-") and s["end"].startswith("2026-")
    assert suppression_scope('source="A - Rule"')["conditions"] is False


def test_suppressions_linked_and_checked():
    _, by_id, edges = _build()
    scanner = by_id["acme:esSuppression:Scanner noise"]
    assert scanner["properties"]["wholeDetection"] is False and "health" not in scanner
    rule = (
        "acme:correlationSearch:SplunkEnterpriseSecuritySuite/"
        "Access - Excessive Failed Logins - Rule"
    )
    assert (scanner["id"], rule, "uses") in edges
    mute = by_id["acme:esSuppression:Mute brute force"]
    assert (
        "Suppresses every finding of ESCU - Brute Force"
        in _checks(mute)["suppressesWholeDetection"]
    )
    assert (mute["id"], BRUTE, "uses") in edges
    window = by_id["acme:esSuppression:Change window"]
    assert "suppresses nothing now" in _checks(window)["suppressionExpired"]
    assert window["usage"]["unused"] is True


def test_aggregation_and_finding_suppression_rules():
    bundle, by_id, edges = _build()
    agg = by_id["acme:esAggregationRule:Group by user"]
    assert agg["properties"]["ruleType"] == "aggregation"
    assert agg["properties"]["group_by"] == "user" and agg["properties"]["time_window"] == "1d"
    assert (agg["id"], BRUTE, "uses") in edges
    sup = by_id["acme:esSuppression:Known pentest"]  # an ES 8 finding suppression rule
    assert sup["properties"]["kind"] == "findingRule"
    assert sup["properties"]["condition"] == "src_ip=10.9.9.9"
    # Read twice (all rules, then suppression rules): catalogued once.
    assert sum(1 for e in bundle["entities"] if e["name"] == "Known pentest") == 1


def test_automation_rules_queues_and_soar_apps_without_secrets():
    bundle, by_id, edges = _build()
    auto = by_id["acme:esAutomationRule:Enrich brute force"]
    assert auto["properties"]["trigger"] == "finding_created"
    assert (auto["id"], BRUTE, "uses") in edges
    queue = by_id["acme:esQueue:Tier 1"]
    assert queue["permissions"] == {"read": ["ess_admin", "ess_analyst"], "write": ["ess_admin"]}
    app = by_id["acme:soarApp:VirusTotal v3"]
    assert app["properties"]["configuredInES"] is True
    assert app["properties"]["app_version"] == "2.3.1"
    text = json.dumps(bundle)
    assert "never-store-me" not in text and "never-this-either" not in text


def test_response_shapes():
    assert _mc_items([{"a": 1}]) == [{"a": 1}]
    assert _mc_items({"items": [{"a": 1}], "total": 1}) == [{"a": 1}]
    assert _mc_items({"whatever": [{"a": 1}], "count": 1}) == [{"a": 1}]
    assert _mc_items({"message": "x"}) == []


class Es7(FixtureTransport):
    """ES 7: no Mission Control."""

    def get(self, path, params=None):
        if "/missioncontrol/" in path:
            raise EndpointNotFound(path)
        return super().get(path, params)


def test_es7_skips_mission_control():
    bundle, by_id, _ = _build(Es7(FIXTURE))
    report = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    assert report["enterpriseSecurity.automationRules"] == "skipped"
    assert report["enterpriseSecurity.suppressions"] == "ok"
    assert "acme:esSuppression:Mute brute force" in by_id
