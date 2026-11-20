"""Microsoft add-ons: inputs (Cloud Services, Office 365, Azure, Security) and their
accounts and tenants, never their secrets."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.microsoft import account_properties, microsoft_input
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import EndpointNotFound, FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
TENANT = "0f1e2d3c-aaaa-bbbb-cccc-111122223333"


def _build(transport=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme")
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def test_accounts_of_all_four_add_ons():
    _, by_id, _ = _build()
    mscs = by_id["acme:addOnAccount:Splunk_TA_microsoft-cloudservices/prod_app"]["properties"]
    assert mscs == {
        "addOn": "Splunk Add-on for Microsoft Cloud Services",
        "accountKind": "Azure App Account",
        "tenantId": TENANT,
        "clientId": "11111111-2222-3333-4444-555555555555",
        "cloudEnvironment": "Azure Public Cloud",
    }
    o365 = by_id["acme:addOnAccount:splunk_ta_o365/acme_tenant"]["properties"]
    assert o365["accountKind"] == "Tenant" and o365["cloudEnvironment"] == "Worldwide"
    assert o365["tenantSubdomain"] == "acme" and o365["tenantDataCenter"] == "eu2"
    aad = by_id["acme:addOnAccount:TA-MS-AAD/aad_reader"]["properties"]
    assert aad["clientId"] == "33333333-4444-5555-6666-777777777777"  # stored as "username"
    sec = by_id["acme:addOnAccount:Splunk_TA_MS_Security/defender"]["properties"]
    assert sec["cloudEnvironment"] == "Global" and sec["authType"] == "client_secret"


def test_secrets_never_read():
    bundle, _, _ = _build()
    text = json.dumps(bundle)
    assert "real-looking-secret-should-not-appear" not in text
    assert "********" not in text
    for e in bundle["entities"]:
        if e["type"] == "addOnAccount":  # only identifiers; "client_secret" may be an auth type
            assert not [k for k in e["properties"] if "secret" in k.lower() or "token" in k.lower()]
    props = account_properties(
        "TA-MS-AAD", {"username": "u", "password": "p", "client_secret": "s"}
    )
    assert "p" not in props.values() and "s" not in props.values()


def test_inputs_name_add_on_service_and_account():
    _, by_id, edges = _build()
    o365 = by_id["acme:input:splunk_ta_o365/splunk_ta_o365_management_activity://exchange_audit"]
    ms = o365["properties"]["microsoft"]
    assert ms["addOn"] == "Splunk Add-on for Microsoft Office 365"
    assert ms["service"] == "Office 365 Management Activity (audit)"
    assert ms["account"] == "acme_tenant" and ms["settings"]["content_type"] == "Audit.Exchange"
    assert (o365["id"], "acme:addOnAccount:splunk_ta_o365/acme_tenant", "uses") in edges
    signins = by_id["acme:input:TA-MS-AAD/MS_AAD_signins://signins"]
    assert signins["properties"]["microsoft"]["service"] == "Entra ID sign-ins"
    assert (signins["id"], "acme:addOnAccount:TA-MS-AAD/aad_reader", "uses") in edges
    defender = by_id[
        "acme:input:Splunk_TA_MS_Security/microsoft_365_defender_endpoint_incidents://incidents"
    ]
    assert defender["properties"]["microsoft"]["service"] == "Microsoft 365 Defender incidents"
    eh = by_id["acme:input:Splunk_TA_microsoft-cloudservices/mscs_azure_event_hub://prod_signins"]
    assert (
        eh["id"],
        "acme:addOnAccount:Splunk_TA_microsoft-cloudservices/prod_app",
        "uses",
    ) in edges


def test_service_names():
    for kind, service in [
        ("o365_graph_api_teams", "Teams usage reports"),
        ("splunk_ta_o365_msg_trace", "Exchange Online message trace"),
        ("o365_cloud_application_security", "Defender for Cloud Apps"),
        ("MS_AAD_identity_protection", "Entra ID Identity Protection"),
        ("azure_reservation_recommendation", "Azure reservation recommendations"),
        ("microsoft_defender_endpoint_atp_alerts", "Defender for Endpoint alerts"),
        ("microsoft_defender_threat_intelligence_datasets", "Defender Threat Intelligence"),
        ("mscs_azure_kql", "Log Analytics (KQL)"),
    ]:
        assert microsoft_input(kind, None, {})["service"] == service, kind


class NoAddOns(FixtureTransport):
    def get(self, path, params=None):
        if any(
            a in path
            for a in ("ta_mscs_azureaccount", "o365_tenants", "AAD_account", "Security_account")
        ):
            raise EndpointNotFound(path)
        return super().get(path, params)


def test_skipped_without_microsoft_add_ons_and_public_profile():
    bundle, _, _ = _build(NoAddOns(FIXTURE))
    report = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    assert report["splunk.microsoftAccounts"] == "skipped"
    bundle, _, _ = _build()
    public = copy.deepcopy(bundle)
    redact_bundle(public, load_profile("public"), salt="t")
    text = json.dumps(public)
    assert TENANT not in text and "11111111-2222-3333-4444-555555555555" not in text
