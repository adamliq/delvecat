"""Stream: sourcetypes per stream, estimate mode, expired captures, filters, missing
streams in groups, and streams that do not arrive."""

from __future__ import annotations

import time
from datetime import datetime, timezone

from delvecat_ingest.bundle import assemble
from delvecat_ingest.connectors import stream
from delvecat_ingest.transport import EndpointNotFound

NOW = datetime(2026, 11, 25, 23, 0, tzinfo=timezone.utc)
KV = "/servicesNS/nobody/splunk_app_stream/storage/collections/data/"


def f(name, agg=None, on=True):
    d = {"name": name, "term": f"x.{name}", "enabled": on}
    if agg:
        d["aggType"] = agg
    return d


STREAMS = [
    {
        "id": "http",
        "protocolName": "http",
        "streamType": "event",
        "enabled": True,
        "index": "main",
        "fields": [f("site"), f("cookie", on=False)],
    },
    {
        "id": "dns",
        "protocolName": "dns",
        "streamType": "event",
        "enabled": True,
        "index": "stream",
        "fields": [f("query")],
    },
    {
        "id": "http_slow",
        "protocolName": "http",
        "streamType": "agg",
        "enabled": True,
        "index": "stream",
        "fields": [f("site", "key"), f("time_taken", "avg"), f("count", "sum")],
        "filters": {
            "matchAllComparisons": True,
            "comparisons": [{"term": "http.time-taken", "comparisonType": ">", "value": "2000000"}],
        },
    },
    {
        "id": "tcp",
        "protocolName": "tcp",
        "streamType": "event",
        "enabled": True,
        "index": "netflow",
        "fields": [f("dest_port")],
        "filters": {
            "matchAllComparisons": False,
            "comparisons": [
                {"term": "flow.dest-port", "comparisonType": "=", "value": "22"},
                {"term": "flow.dest-port", "comparisonType": "=", "value": "3389"},
            ],
        },
    },
    {
        "id": "tls",
        "protocolName": "tls",
        "enabled": True,
        "sendToIndexer": False,
        "index": "stream",
        "fields": [],
    },
    {
        "id": "pcap_42",
        "appName": "Splunk_ES",
        "protocolName": "tcp",
        "enabled": True,
        "index": "stream",
        "expirationDate": int(time.time()) - 3 * 86400,
        "fields": [],
    },
    {"id": "ftp", "protocolName": "ftp", "enabled": True, "index": "stream", "fields": []},
    {"id": "smtp", "protocolName": "smtp", "enabled": False, "index": "stream", "fields": []},
]
GROUPS = [
    {"name": "dmz", "rule": "fwd-dmz-.*", "streams": ["http", "dns", "http_slow", "pcap_42"]},
    {"name": "core", "rule": r"fwd-core-\d+", "streams": ["tcp", "ftp_legacy"]},
]
ROWS = [
    {
        "host": "fwd-dmz-01",
        "sourcetype": s,
        "index": "stream",
        "count": "10",
        "lastSeen": "1795690000",
    }
    for s in ("stream:http", "stream:dns", "stream:http_slow")
] + [
    {
        "host": "fwd-dmz-02",
        "sourcetype": "stream:http",
        "index": "main",
        "count": "5",
        "lastSeen": "1795690000",
    },
    {
        "host": "fwd-core-01",
        "sourcetype": "stream:tcp",
        "index": "netflow",
        "count": "5",
        "lastSeen": "1795690000",
    },
]


class Mem:
    def __init__(self, rows):
        self.rows = rows

    def get(self, path, params=None):
        docs = {KV + "streams": STREAMS, KV + "streamforwardergroups": GROUPS}
        if path not in docs:
            raise EndpointNotFound(path)
        return docs[path]

    def search(self, name, spl, earliest="-24h", latest="now"):
        return self.rows


def build(rows=ROWS):
    r = stream.extract(Mem(rows), "s")
    b = assemble([{"id": "s", "name": "s", "kind": "splunkEnterprise"}], r, NOW)
    return {e["name"]: e for e in b["entities"] if e["type"].startswith("stream")}, b


def feeds(b, name):
    return sorted(
        x["to"].split(":", 2)[2]
        for x in b["edges"]
        if x["from"] == f"s:streamDefinition:{name}" and x["type"] == "feeds"
    )


def checks(e):
    return {c["check"]: c["message"] for c in (e.get("health") or {}).get("checks", [])}


def test_sourcetype_is_named_after_the_stream():
    s, b = build()
    assert s["http_slow"]["properties"]["sourcetype"] == "stream:http_slow"
    refs = [r for r in b.get("references", []) if r.get("known") == "s:streamDefinition:http_slow"]
    targets = {(r["target"]["type"], r["target"]["name"]) for r in refs} | {
        tuple(x["to"].split(":", 2)[1:])
        for x in b["edges"]
        if x["from"] == "s:streamDefinition:http_slow" and x["type"] == "feeds"
    }
    assert ("sourcetype", "stream:http_slow") in targets
    assert ("sourcetype", "stream:http") not in targets


def test_estimate_mode_and_expired_captures_feed_nothing():
    s, b = build()
    tls, pcap = s["tls"]["properties"], s["pcap_42"]["properties"]
    assert tls["mode"] == "estimate" and tls["sendsData"] is False
    assert pcap["ephemeral"] and pcap["expired"] and pcap["createdBy"] == "Splunk_ES"
    assert feeds(b, "tls") == [] and feeds(b, "pcap_42") == []
    assert "Ephemeral capture expired" in checks(s["pcap_42"])["streamExpired"]


def test_filters_and_aggregation_are_kept():
    s, _ = build()
    assert s["tcp"]["properties"]["filters"] == {
        "match": "any",
        "rules": ["flow.dest-port = 22", "flow.dest-port = 3389"],
    }
    assert s["http_slow"]["properties"]["aggregation"] == {
        "keys": ["site"],
        "measures": ["avg(time_taken)", "sum(count)"],
    }
    assert s["http"]["properties"]["fields"] == ["site"]


def test_group_naming_a_missing_stream():
    s, b = build()
    assert s["core"]["properties"]["missingStreams"] == ["ftp_legacy"]
    assert checks(s["core"])["streamMissing"] == "Deploys streams that do not exist: ftp_legacy"
    assert not any(x["to"].endswith("ftp_legacy") for x in b["edges"])


def test_streams_and_forwarders_without_data():
    s, _ = build()
    assert checks(s["ftp"])["streamNoData"] == "No forwarder sent stream:ftp in the last 7 days"
    assert "streamNoData" not in checks(s["http_slow"])
    assert "health" not in s["smtp"]  # disabled
    # dmz-02 does not send dns; http_slow is filtered, so its silence can be normal
    assert s["fwd-dmz-02"]["properties"]["notSending"] == ["dns"]
    assert "notSending" not in s["fwd-dmz-01"]["properties"]
    assert "notSending" not in s["fwd-core-01"]["properties"]  # tcp is filtered


def test_no_stream_data_searchable_means_no_data_checks():
    s, _ = build(rows=[])
    assert "observedSending" not in s["ftp"]["properties"]
    assert "streamNoData" not in checks(s["ftp"])
