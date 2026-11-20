"""SPL2 from Splunk's Data Orchestrator: connections, modules, SPL2-native datasets."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.spl2 import app_of, module_permissions, spl2_reads
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import EndpointNotFound, FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
MODULE = "acme:spl2Module:acme_web/web_errors"


def _build(transport=None, parts=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme", parts=parts)
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def test_connections_name_host_port_account_only():
    _, by_id, _ = _build()
    c = by_id["acme:spl2Connection:soc_cluster"]
    assert c["properties"] == {
        "dataSource": "Splunk",
        "host": "https://soc-sh.acme.example",
        "port": 8089,
        "account": "spl2_svc",
        "status": "published",
        "created": "2026-10-02T09:00:00Z",
    }
    assert by_id["acme:spl2Connection:default_connection"]["properties"]["account"] == "Splunk"


def test_module_with_owner_permissions_source_and_lineage():
    bundle, by_id, edges = _build()
    m = by_id[MODULE]
    assert m["app"] == "acme_web" and m["owner"] == "jlee"
    assert m["permissions"] == {"read": ["power", "user"], "write": ["admin"]}
    assert m["properties"]["version"] == 3 and m["properties"]["updatedBy"] == "admin"
    assert m["properties"]["definition"].startswith("$errors = from web")
    assert ("acme:app:acme_web", MODULE, "contains") in edges
    reads = {t for f, t, k in edges if f == MODULE and k == "reads"}
    # asset_owners is shared from TA-acme-firewall: the visible one is linked.
    assert reads == {"acme:index:web", "acme:lookup:TA-acme-firewall/asset_owners"}


def test_spl2_native_datasets_only():
    bundle, by_id, _ = _build()
    native = [e for e in bundle["entities"] if e["type"] == "spl2Dataset"]
    assert sorted((e["name"], e["properties"]["kind"]) for e in native) == [
        ("signin_archive", "azure_abs"),
        ("vpc_flow_s3", "fa_aws_s3"),
        ("web_export", "dmx_azure_blob"),
    ]


def test_helpers():
    assert app_of("~.apps.acme_web") == "acme_web" and app_of("~indexes") is None
    assert module_permissions([{"role": "a", "operations": ["read", "write"]}]) == {
        "read": ["a"],
        "write": ["a"],
    }
    assert module_permissions([]) is None
    kinds = {"web": "index", "x": "savedsearch"}
    assert spl2_reads("$a = from web; $b = from $a; $c = from index:web; $d = from x", kinds) == [
        ("index", "web"),
        ("savedSearch", "x"),
    ]


class NoOrchestrator(FixtureTransport):
    """Splunk 9.x, or the orchestrator not started yet."""

    def get(self, path, params=None):
        if path.startswith("/services/orchestrator/"):
            raise EndpointNotFound(path)
        return super().get(path, params)


def test_skipped_without_the_orchestrator():
    bundle, _, _ = _build(NoOrchestrator(FIXTURE))
    report = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    assert report["splunk.spl2"] == "skipped"
    assert not [e for e in bundle["entities"] if e["type"].startswith("spl2")]


def test_public_profile_hides_connection_hosts_and_accounts():
    bundle, _, _ = _build()
    redact_bundle(bundle, load_profile("public"), salt="t")
    text = json.dumps([e for e in bundle["entities"] if e["type"] == "spl2Connection"])
    assert "soc-sh.acme.example" not in text and "spl2_svc" not in text


def test_azure_connection_without_credentials():
    bundle, by_id, _ = _build()
    c = by_id["acme:spl2Connection:azure_lake_conn"]
    p = c["properties"]
    assert p["dataSource"] == "Azure" and p["authMethods"] == ["servicePrincipal"]
    assert p["azureTenantId"] == "9a8b7c6d-1111-2222-3333-444455556666"
    assert p["storageAccount"] == "acmesecuritylake" and p["container"] == "logs"
    assert p["supportedCapabilities"] == ["search", "export"] and p["accessLevel"] == "PUBLISHED"
    assert c["description"] == "Security data lake on ADLS"
    text = json.dumps(bundle)
    assert "never-store-this" not in text and "app-id-1" not in text


def test_azure_datastores_with_location_and_connection():
    bundle, by_id, edges = _build()
    lake = by_id["acme:spl2Dataset:~.apps.acme_secops.signin_archive"]
    assert lake["app"] == "acme_secops"
    want = {
        "kind": "azure_abs",
        "dataSource": "Azure",
        "connection": "azure_lake_conn",
        "storageAccount": "acmesecuritylake",
        "container": "logs",
        "directory": "entra/signins",
        "dataFormat": "parquet",
    }
    assert {k: lake["properties"].get(k) for k in want} == want
    assert (lake["id"], "acme:spl2Connection:azure_lake_conn", "uses") in edges
    export = by_id["acme:spl2Dataset:~.apps.acme_web.web_export"]
    p = export["properties"]
    assert p["dataSource"] == "Azure" and p["kind"] == "dmx_azure_blob"
    assert (p["storageAccount"], p["container"], p["directory"]) == (
        "acmeexports",
        "splunk-export",
        "web",
    )
    assert p["compressionType"] == "gzip" and p["filePrefix"] == "web_"
    assert "never-store-this-either" not in json.dumps(bundle)


def test_public_profile_hides_azure_locations_and_tenant():
    bundle, _, _ = _build()
    redact_bundle(bundle, load_profile("public"), salt="t")
    text = json.dumps([e for e in bundle["entities"] if e["type"].startswith("spl2")])
    for v in ("acmesecuritylake", "acmeexports", "9a8b7c6d-1111", "entra/signins"):
        assert v not in text
