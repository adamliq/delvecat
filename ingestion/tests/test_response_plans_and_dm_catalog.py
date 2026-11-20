"""ES 8 response plans, and the Data Management metadata catalog."""

from __future__ import annotations

from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import EndpointNotFound, FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def _build(transport=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme")
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def test_response_plans():
    _, by_id, _ = _build()
    plan = by_id["acme:responseTemplate:Phishing response"]
    assert plan["product"] == "enterpriseSecurity"
    assert plan["description"] == "Triage and contain reported phishing"
    p = plan["properties"]
    assert p["creator"] == "jlee" and p["updatedBy"] == "admin"
    assert p["status"] == "published" and p["templateId"] == "tpl-phish"
    assert p["created"].startswith("2026-") and plan["updatedAt"].startswith("2026-")  # ms epoch
    draft = by_id["acme:responseTemplate:Ransomware"]
    assert draft["properties"]["status"] == "draft" and not draft["properties"].get("templateId")


def test_data_management_catalog_objects():
    _, by_id, edges = _build()
    web = by_id["acme:dmCatalogObject:indexes.web"]
    assert (
        web["properties"]["kind"] == "splunk_index" and web["properties"]["namespace"] == "indexes"
    )
    assert (web["id"], "acme:index:web", "mapsTo") in edges
    pipe = by_id["acme:dmCatalogObject:pipelines.fw_to_s3"]
    assert pipe["owner"] == "jlee" and pipe["properties"]["objectType"] == "pipeline"
    assert "acme:dmCatalogObject:destinations.archive_bucket" in by_id


class NoServices(FixtureTransport):
    """Splunk Enterprise (no metadata catalog service) and ES 7 (no response plans)."""

    def get(self, path, params=None):
        if "/mdc/" in path or "/missioncontrol/" in path:
            raise EndpointNotFound(path)
        return super().get(path, params)


def test_skipped_where_not_available():
    bundle, _, _ = _build(NoServices(FIXTURE))
    report = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    assert report["splunk.dataManagementCatalog"] == "skipped"
    assert report["enterpriseSecurity.responsePlans"] == "skipped"
