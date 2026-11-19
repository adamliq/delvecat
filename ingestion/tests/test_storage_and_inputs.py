"""Index storage tiers and retention (Splunk Enterprise and Splunk Cloud), and the inputs
only inputs.conf lists (batch, Windows, ...)."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.data import frozen_action, index_storage
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def _build(parts=None):
    bundle = build_here(FixtureTransport(FIXTURE), "acme", parts=parts)
    return bundle, {e["id"]: e for e in bundle["entities"]}


def _tiers(index):
    return {t["tier"]: t for t in index["properties"]["storage"]["tiers"]}


def test_retention_and_tiers_of_a_classic_index():
    _, by_id = _build()
    web = by_id["acme:index:web"]
    p = web["properties"]
    assert p["retentionDays"] == 2184.0 and p["maxTotalDataSizeMB"] == 500000
    assert p["frozenAction"] == "delete"
    assert p["storage"]["model"] == "classic"
    t = _tiers(web)
    assert list(t) == ["hot", "warm", "cold", "frozen", "thawed"]
    assert t["hot"]["buckets"] == 2 and t["warm"]["buckets"] == 14
    assert t["warm"]["sizeMB"] == 820.5
    assert t["cold"] == {
        "tier": "cold",
        "path": t["cold"]["path"],
        "buckets": 40,
        "sizeMB": 3120.25,
    }
    assert p["storage"]["oldestEventInHome"].startswith("2026-")


def test_index_near_its_size_limit_freezes_by_size():
    _, by_id = _build()
    fw = by_id["acme:index:firewall"]
    assert fw["properties"]["frozenAction"] == "archiveDir"
    assert _tiers(fw)["frozen"] == {
        "tier": "frozen",
        "action": "archiveDir",
        "path": "/archive/firewall",
    }
    assert _tiers(fw)["hot"]["maxSizeMB"] == 5000  # homePath.maxDataSizeMB
    checks = {c["check"]: c["message"] for c in fw["health"]["checks"]}
    assert "Uses 19,200 MB of its 20,000 MB limit" in checks["retentionBySize"]
    assert "before its 365-day retention" in checks["retentionBySize"]
    assert "retentionBySize" not in {
        c["check"] for c in (by_id["acme:index:web"].get("health") or {}).get("checks", [])
    }


def test_smartstore_has_remote_warm_and_no_cold():
    s = index_storage(
        {
            "homePath": "$SPLUNK_DB/web/db",
            "remotePath": "volume:remote_store/$_index_name",
            "maxHotBuckets": "auto",
            "coldPath": "$SPLUNK_DB/web/colddb",
        },
        {},
    )
    tiers = {t["tier"]: t for t in s["tiers"]}
    assert s["model"] == "smartStore" and "cold" not in tiers
    assert tiers["warm"] == {
        "tier": "warm",
        "path": "volume:remote_store/$_index_name",
        "remote": True,
    }
    assert "maxBuckets" not in tiers["hot"]  # "auto"


def test_splunk_cloud_archives():
    ddaa = {
        "archiver.enableDataArchive": "1",
        "archiver.coldStorageProvider": "Glacier",
        "archiver.coldStorageRetentionPeriod": "1095",
    }
    assert frozen_action(ddaa) == {
        "action": "activeArchive",
        "provider": "Glacier",
        "archiveRetentionDays": 1095,
    }
    ddss = {
        "archiver.selfStorageProvider": "S3",
        "archiver.selfStorageBucketPath": "s3://acme-frozen/web",
    }
    assert frozen_action(ddss) == {
        "action": "selfStorage",
        "provider": "S3",
        "path": "s3://acme-frozen/web",
    }
    assert frozen_action({"coldToFrozenScript": "/opt/archive.sh"})["action"] == "archiveScript"
    assert frozen_action({}) == {"action": "delete"}


def test_public_profile_drops_object_store_locations():
    bundle, _ = _build()
    web = next(e for e in bundle["entities"] if e["id"] == "acme:index:web")
    web["properties"]["remotePath"] = "s3://acme-smartstore/web"
    web["properties"]["storage"]["tiers"][1]["path"] = "s3://acme-smartstore/web"
    redact_bundle(bundle, load_profile("public"), salt="t")
    assert "acme-smartstore" not in json.dumps(bundle)


def test_batch_windows_and_other_inputs_from_inputs_conf():
    bundle, by_id = _build()
    batch = by_id["acme:input:search/batch://$SPLUNK_HOME/var/spool/splunk"]
    assert batch["properties"]["kind"] == "batch"
    assert batch["properties"]["deletesFilesAfterReading"] is True
    win = by_id["acme:input:TA-acme-firewall/WinEventLog://Security"]
    assert win["properties"]["renderXml"] is True
    perf = by_id["acme:input:TA-acme-firewall/perfmon://CPU"]
    assert perf["disabled"] is True and perf["properties"]["counters"] == "% Processor Time"
    assert by_id["acme:input:search/fschange:///etc"]["properties"]["kind"] == "fschange"
    feeds = {(x["from"], x["to"]) for x in bundle["edges"] if x["type"] == "feeds"}
    assert (win["id"], "acme:index:wineventlog") in feeds
    assert not any(f == perf["id"] for f, _ in feeds)  # disabled feeds nothing
    # Kinds with their own REST list are not read twice.
    udp = [e for e in bundle["entities"] if e["type"] == "input" and e["name"] == "udp://5514"]
    assert len(udp) <= 1
