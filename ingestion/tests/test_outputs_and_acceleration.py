"""Forwarding outputs (outputs.conf) and acceleration summaries."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def _build():
    bundle = build_here(FixtureTransport(FIXTURE), "acme")
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def _checks(e):
    return {c["check"]: c["message"] for c in (e.get("health") or {}).get("checks", [])}


def test_output_groups():
    bundle, by_id, _ = _build()
    primary = by_id["acme:outputGroup:tcpout:primary_indexers"]
    p = primary["properties"]
    assert primary["displayName"] == "primary_indexers" and p["default"] is True
    assert p["indexerDiscovery"] == "cm1" and p["clusterManager"] == "https://cm.acme.example:8089"
    assert p["useAck"] is True and p["ssl"] is True
    siem = by_id["acme:outputGroup:tcpout:siem_group"]["properties"]
    assert siem["servers"] == ["siem1.acme.example:9997", "siem2.acme.example:9997"]
    assert siem["default"] is False and siem["compressed"] is True
    assert by_id["acme:outputGroup:tcpout:archive_group"]["disabled"] is True
    syslog = by_id["acme:outputGroup:syslog:siem_syslog"]["properties"]
    assert syslog["protocol"] == "tcp" and syslog["servers"] == ["siem-syslog.acme.example:514"]
    http = by_id["acme:outputGroup:httpout"]["properties"]
    assert http["uri"] == "https://hec.acme.example:8088"
    rfs = by_id["acme:outputGroup:rfs:s3_archive"]["properties"]
    assert rfs["provider"] == "Amazon S3" and rfs["bucket"] == "acme-ia-archive"
    forwarding = bundle["instances"][0]["properties"]["forwarding"]
    assert forwarding["tcpoutDefaultGroups"] == ["primary_indexers"]
    assert forwarding["indexAndForward"] is True


def test_secrets_never_read():
    bundle, _, _ = _build()
    text = json.dumps(bundle)
    for secret in (
        "cleartext-p4sk-should-never-appear",
        "hec-token-should-never-appear",
        "$7$fake",
    ):
        assert secret not in text


def test_forwarding_transforms_link_to_their_output_groups():
    _, _, edges = _build()
    t = "acme:transform:TA-acme-firewall/fw_copy_to_siem"  # _TCP_ROUTING siem_group, archive_group
    assert (t, "acme:outputGroup:tcpout:siem_group", "writes") in edges
    assert (t, "acme:outputGroup:tcpout:archive_group", "writes") in edges


def test_data_model_and_report_summaries():
    _, by_id, edges = _build()
    web = by_id["acme:accelerationSummary:DM_acme_web_Acme_Web"]
    p = web["properties"]
    assert p["kind"] == "dataModel" and p["dataModel"] == "Acme_Web"
    assert p["sizeMB"] == 500.0 and p["completePercent"] == 98.0 and p["accessCount"] == 412
    assert (web["id"], "acme:dataModel:acme_web/Acme_Web", "accelerates") in edges
    assert "health" not in web  # used yesterday, built fine
    cim = by_id["acme:accelerationSummary:DM_Splunk_SA_CIM_Network_Traffic"]
    assert cim["properties"]["dataModel"] == "Network_Traffic"  # app name has underscores
    assert "Search auto-canceled" in _checks(cim)["summaryError"]
    report = by_id["acme:accelerationSummary:ABC_acme_web_admin_NS1"]
    assert report["properties"]["kind"] == "report"
    assert report["properties"]["reports"] == ["Web - Top Error Pages"]
    search = "acme:savedSearch:acme_web/Web - Top Error Pages"
    assert (report["id"], search, "accelerates") in edges
    assert "No search has used it for" in _checks(report)["summaryUnused"]
    assert report["usage"]["unused"] is True
    # Each summary once, although the two listings were both answered.
    assert sum(1 for k in by_id if k.startswith("acme:accelerationSummary:")) == 3


def test_public_profile_hides_destinations():
    bundle, _, _ = _build()
    public = copy.deepcopy(bundle)
    redact_bundle(public, load_profile("public"), salt="t")
    text = json.dumps([e for e in public["entities"] if e["type"] == "outputGroup"])
    for v in ("siem1.acme.example", "hec.acme.example", "cm.acme.example", "acme-ia-archive"):
        assert v not in text
