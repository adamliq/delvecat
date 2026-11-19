"""Scheduled views (a dashboard emailed as a PDF on a schedule) and Pivot reports."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.knowledge import pivot_of
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
VIEW = "acme:scheduledView:acme_web/_ScheduledView__storefront_health"
DASHBOARD = "acme:dashboard:acme_web/storefront_health"
PIVOT = "acme:savedSearch:acme_web/Web - Requests by Status (Pivot)"


def _build(parts=None):
    bundle = build_here(FixtureTransport(FIXTURE), "acme", parts=parts)
    return bundle, {e["id"]: e for e in bundle["entities"]}


def test_scheduled_view_is_its_own_object_linked_to_its_dashboard():
    bundle, by_id = _build()
    v = by_id[VIEW]
    assert v["displayName"] == "Scheduled PDF of storefront_health"
    p = v["properties"]
    assert p["dashboard"] == "storefront_health" and p["cronSchedule"] == "0 7 * * 1"
    assert p["subject"] == "Storefront health (weekly)" and p["paperSize"] == "a4"
    assert p["alertRecipients"] == {
        "to": ["web-team@acme.example", "$env:user$"],
        "cc": ["cto@acme.example"],
    }
    assert v.get("description") is None  # not Splunk's generated text
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    assert (VIEW, DASHBOARD, "reads") in edges
    assert ("acme:app:acme_web", VIEW, "contains") in edges
    # Its saved-search face is not catalogued a second time as a saved search.
    assert not any(
        e["name"].startswith("_ScheduledView__")
        for e in bundle["entities"]
        if e["type"] == "savedSearch"
    )


def test_scheduled_view_runs_and_failures():
    _, by_id = _build()
    v = by_id[VIEW]
    assert v["usage"]["scheduler"]["failed"] == 1
    assert {c["check"] for c in v["health"]["checks"]} >= {"failed"}


def test_public_profile_keeps_only_recipient_domains():
    bundle, _ = _build()
    redact_bundle(bundle, load_profile("public"), salt="t")
    v = next(e for e in bundle["entities"] if e["type"] == "scheduledView")
    assert "web-team@acme.example" not in json.dumps(v)


def test_pivot_reports_name_their_data_model_and_dataset():
    bundle, by_id = _build()
    assert by_id[PIVOT]["properties"]["pivot"] == {"dataModel": "Acme_Web", "dataset": "Requests"}
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    assert (PIVOT, "acme:dataModel:acme_web/Acme_Web", "reads") in edges
    assert pivot_of('| pivot "My Model" "Root Search" count(x)') == {
        "dataModel": "My Model",
        "dataset": "Root Search",
    }
    assert pivot_of("index=web | stats count") is None


def test_part_can_be_left_out():
    bundle, _ = _build(parts={"dashboards", "savedSearches"})
    assert not [e for e in bundle["entities"] if e["type"] == "scheduledView"]
