"""Sourcetype renames, field filters, fields.conf, navigation menus, time ranges, prebuilt
panels, visualizations, multikv tables, segmenters, Ingest Actions rulesets, and the
commands searches run."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from delvecat_ingest.connectors.splunk.extras import parse_field_filter_action
from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
VIEWS = "/servicesNS/-/-/data/ui/views"
PROPS = "/servicesNS/-/-/configs/conf-props"
SAVED = "/servicesNS/-/-/saved/searches"
COMMANDS = "/servicesNS/-/-/configs/conf-commands"

DASHBOARD = (
    '<dashboard><label>Ops</label><row><panel ref="web_errors_by_status" app="acme_web"/></row>'
    '<row><panel><viz type="acme_web.status_sankey"><search><query>index=web | stats count by '
    "uri_path, status</query></search></viz></panel></row></dashboard>"
)


class Extra(FixtureTransport):
    """The recorded instance plus a dashboard using a panel and a custom visualization, an
    Ingest Actions ruleset, and searches running risky commands."""

    def get(self, path, params=None):
        body = super().get(path, params)
        if path == VIEWS:
            e = copy.deepcopy(body["entry"][0])
            e["name"], e["acl"]["app"] = "ops_overview", "acme_web"
            e["content"].update({"eai:data": DASHBOARD, "label": "Ops"})
            body = {**body, "entry": [*body["entry"], e]}
        elif path == PROPS:
            body = copy.deepcopy(body)
            for e in body["entry"]:
                if e["name"] == "acme:fw":
                    e["content"]["RULESET-drop_debug"] = "fw_drop_heartbeat"
        elif path == SAVED:
            body = copy.deepcopy(body)
            e = copy.deepcopy(body["entry"][0])
            e["name"] = "Purge test events"
            e["content"].update({"search": "index=web sourcetype=test | delete", "disabled": False})
            e2 = copy.deepcopy(body["entry"][0])
            e2["name"] = "Mail top pages"
            e2["content"].update(
                {
                    "search": "index=web | top uri_path | sendemail to=ops@example.com",
                    "disabled": False,
                }  # fmt: skip
            )
            body["entry"] += [e, e2]
        if isinstance(body.get("paging"), dict):
            body = {**body, "paging": {**body["paging"], "total": len(body["entry"])}}
        return body


@pytest.fixture(scope="module")
def bundle():
    return build_here(Extra(FIXTURE), "acme")


@pytest.fixture(scope="module")
def by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def edges(bundle, frm):
    return {(x["type"], x["to"]) for x in bundle["edges"] if x["from"] == frm}


def one(bundle, type_, name):
    types = {type_, "correlationSearch"} if type_ == "savedSearch" else {type_}
    return next(e for e in bundle["entities"] if e["type"] in types and e["name"] == name)


def test_sourcetype_rename(bundle, by_id):
    old, new = by_id["acme:sourcetype:acme:legacy"], by_id["acme:sourcetype:acme:fw"]
    assert old["properties"]["renamedTo"] == "acme:fw"
    assert new["properties"]["renamedFrom"] == ["acme:legacy"]
    assert ("mapsTo", new["id"]) in edges(bundle, old["id"])


def test_field_filter(bundle):
    f = one(bundle, "fieldFilter", "web_client_ip")
    p = f["properties"]
    assert (p["field"], p["action"], p["hash"]) == ("clientip", "hash", "sha256")
    assert p["indexes"] == ["web"] and p["roleExemptions"] == ["web_admin"]
    assert p["limit"] == {"type": "sourcetype", "values": ["access_combined"]}
    assert f["description"].startswith("Hash shopper")
    assert {("uses", "acme:index:web"), ("uses", "acme:sourcetype:access_combined")} <= edges(
        bundle, f["id"]
    )


@pytest.mark.parametrize(
    "action, expected",
    [
        ('"password"=null()', {"field": "password", "action": "remove"}),
        ('"userid"=sha512()', {"field": "userid", "action": "hash", "hash": "sha512"}),
        ('"ssn"="xxx-xx-xxx"', {"field": "ssn", "action": "replace", "replacement": "xxx-xx-xxx"}),
        ('"_raw"=sed("s/a/b/g")', {"field": "_raw", "action": "sed", "sed": "s/a/b/g"}),
        ("nonsense", {"raw": "nonsense"}),
    ],
)
def test_field_filter_actions(action, expected):
    assert parse_field_filter_action(action) == expected


def test_fields_conf(bundle):
    p = one(bundle, "fieldDefinition", "fw_action")["properties"]
    assert p["indexed"] is True and p["indexedValue"] == "false"
    assert one(bundle, "fieldDefinition", "punct")["properties"].get("builtin") is True


def test_navigation_menu_links_dashboards_and_reports(bundle):
    nav = next(e for e in bundle["entities"] if e["type"] == "navMenu" and e["app"] == "acme_web")
    assert nav["properties"]["defaultView"] == "storefront_health"
    out = edges(bundle, nav["id"])
    assert ("uses", "acme:dashboard:acme_web/storefront_health") in out
    assert ("uses", "acme:dashboard:acme_web/web_explorer") in out
    assert ("uses", "acme:savedSearch:acme_web/Web - Top Error Pages") in out


def test_time_ranges_panels_visualizations_multikv_segmenters(bundle):
    t = one(bundle, "timeRange", "business_hours_today")
    assert t["displayName"] == "Business hours today" and t["properties"]["earliest"] == "@d+8h"
    panel = one(bundle, "panel", "web_errors_by_status")
    assert panel["displayName"] == "Errors by status"
    assert ("reads", "acme:index:web") in edges(bundle, panel["id"])  # its search is analysed
    assert one(bundle, "visualization", "status_sankey")["description"].startswith("Requests")
    assert one(bundle, "visualization", "line")["properties"]["builtin"] is True
    assert one(bundle, "multikvTable", "PerfmonMk")["properties"]["settings"]
    assert one(bundle, "segmenter", "full")["properties"]["settings"]


def test_dashboards_use_panels_and_visualizations(bundle):
    d = one(bundle, "dashboard", "ops_overview")
    assert d["properties"]["panelRefs"] == ["web_errors_by_status"]
    assert d["properties"]["visualizations"] == ["acme_web.status_sankey"]
    out = edges(bundle, d["id"])
    assert ("uses", one(bundle, "panel", "web_errors_by_status")["id"]) in out
    assert ("uses", one(bundle, "visualization", "status_sankey")["id"]) in out


def test_ingest_actions_rulesets_are_index_time_rules(by_id):
    rules = by_id["acme:sourcetype:acme:fw"]["properties"]["indexTime"]
    ruleset = [r for r in rules if r["rule"] == "RULESET-drop_debug"]
    assert (
        ruleset and ruleset[0]["ruleset"] is True and ruleset[0]["transform"] == "fw_drop_heartbeat"
    )


def test_searches_record_commands_and_risky_ones_are_findings(bundle):
    purge = one(bundle, "savedSearch", "Purge test events")
    assert purge["lineage"]["commands"] == ["delete"]
    checks = {c["check"]: c for c in purge["health"]["checks"]}
    assert "deletes events" in checks["riskyCommand"]["message"]
    mail = one(bundle, "savedSearch", "Mail top pages")
    assert mail["lineage"]["commands"] == ["sendemail", "top"]
    assert any(c["check"] == "riskyCommand" for c in mail["health"]["checks"])
    top = one(bundle, "savedSearch", "Web - Top Error Pages")
    assert not any(
        c["check"] == "riskyCommand" for c in (top.get("health") or {}).get("checks", [])
    )


def test_custom_commands_marked_risky_are_findings():
    class Risky(Extra):
        def get(self, path, params=None):
            body = super().get(path, params)
            if path == COMMANDS:
                body = json.loads(json.dumps(body))
                for e in body["entry"]:
                    e["content"]["is_risky"] = "true"
            return body

    bundle = build_here(Risky(FIXTURE), "acme")
    flagged = [
        e
        for e in bundle["entities"]
        if any(
            c["check"] == "riskyCommand" and "commands.conf" in c["message"]
            for c in (e.get("health") or {}).get("checks", [])
        )
    ]
    assert flagged  # searches running a custom command now marked risky


def test_unused_dashboards_say_whether_a_menu_links_them(bundle):
    reasons = {
        e["name"]: e["usage"].get("reason")
        for e in bundle["entities"]
        if e["type"] == "dashboard" and (e.get("usage") or {}).get("unused")
    }
    if "storefront_health" in reasons:
        assert "in its app's menu" in reasons["storefront_health"]
    assert any("in no app's menu" in r for r in reasons.values() if r)
