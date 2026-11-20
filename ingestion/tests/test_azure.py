"""Azure: Azure Blob Storage for SmartStore and Self Storage, and Azure add-on inputs."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.data import (
    azure_input,
    frozen_action,
    index_storage,
    object_store,
)
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def test_object_stores():
    assert object_store("s3://acme-frozen/web") == {
        "provider": "Amazon S3",
        "bucket": "acme-frozen",
    }
    assert object_store("gs://acme-ss/idx")["provider"] == "Google Cloud Storage"
    assert object_store(
        "azure://splunk-warm/prod",
        {"remote.azure.endpoint": "https://acmesplunk.blob.core.windows.net"},
    ) == {"provider": "Azure Blob Storage", "bucket": "splunk-warm", "storageAccount": "acmesplunk"}
    assert object_store("/opt/splunk/frozen") == {}
    assert object_store(None) == {}


def test_smartstore_volume_on_azure():
    volumes = {
        "azure_store": {
            "path": "azure://splunk-warm/prod",
            "provider": "Azure Blob Storage",
            "bucket": "splunk-warm",
            "storageAccount": "acmesplunk",
        }
    }
    s = index_storage(
        {"homePath": "$SPLUNK_DB/web/db", "remotePath": "volume:azure_store/$_index_name"},
        {},
        volumes,
    )
    warm = {t["tier"]: t for t in s["tiers"]}["warm"]
    assert warm["provider"] == "Azure Blob Storage" and warm["storageAccount"] == "acmesplunk"
    assert warm["bucket"] == "splunk-warm" and warm["volume"] == "azure_store"


def test_self_storage_on_azure():
    f = frozen_action({"archiver.selfStorageBucketPath": "azure://acme-ddss/web"})
    assert f == {
        "action": "selfStorage",
        "provider": "Azure Blob Storage",
        "path": "azure://acme-ddss/web",
        "bucket": "acme-ddss",
    }


def test_volumes_read_from_indexes_conf():
    bundle = build_here(FixtureTransport(FIXTURE), "acme")
    web = next(e for e in bundle["entities"] if e["id"] == "acme:index:infra_metrics")
    warm = {t["tier"]: t for t in web["properties"]["storage"]["tiers"]}["warm"]
    assert warm["provider"] == "Azure Blob Storage" and warm["storageAccount"] == "acmesplunk"
    # Keys in the volume stanza are never read into the catalog.
    assert "fake-azure-key" not in json.dumps(bundle)


def test_azure_add_on_inputs():
    eh = azure_input(
        "mscs_azure_event_hub",
        "Splunk_TA_microsoft-cloudservices",
        {
            "account": "prod_app",
            "event_hub_namespace": "acme-eh",
            "event_hub_name": "insights-logs",
            "consumer_group": "$Default",
            "client_secret": "never",
        },
    )
    assert eh == {
        "service": "Event Hubs",
        "settings": {
            "account": "prod_app",
            "event_hub_namespace": "acme-eh",
            "event_hub_name": "insights-logs",
            "consumer_group": "$Default",
        },
    }
    assert azure_input("MS_AAD_signins", "TA-MS-AAD", {})["service"] == "Entra ID (Azure AD)"
    assert azure_input("mscs_storage_blob", None, {"container_name": "logs"}) == {
        "service": "Storage (Blob)",
        "settings": {"container_name": "logs"},
    }
    assert azure_input("aws_cloudtrail", "Splunk_TA_aws", {}) is None


def test_azure_input_in_the_catalog_and_public_profile():
    bundle = build_here(FixtureTransport(FIXTURE), "acme")
    eh = next(e for e in bundle["entities"] if e["name"] == "mscs_azure_event_hub://prod_signins")
    az = eh["properties"]["azure"]
    assert az["service"] == "Event Hubs"
    assert az["settings"]["event_hub_name"] == "aad-signins"
    assert "do-not-store" not in json.dumps(bundle)  # a secret setting's value
    public = copy.deepcopy(bundle)
    redact_bundle(public, load_profile("public"), salt="t")
    text = json.dumps(public)
    assert "0f1e2d3c-aaaa-bbbb-cccc-111122223333" not in text  # tenant id
    assert "acmesplunk" not in text  # storage account
