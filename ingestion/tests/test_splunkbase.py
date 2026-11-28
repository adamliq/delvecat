"""Splunkbase versions from the Splunkbase Version Catalog app: matching installed apps,
comparing versions, compatibility with this Splunk, archived apps, a catalogue that stopped
refreshing, paging, and the app not being installed."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from delvecat_ingest.bundle import assemble
from delvecat_ingest.connectors import splunk, splunkbase
from delvecat_ingest.inapp import resolve_parts
from delvecat_ingest.model import ExtractResult
from delvecat_ingest.transport import EndpointNotFound

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
CHECKED = int(datetime(2026, 11, 25, 3, 15, tzinfo=timezone.utc).timestamp())


def rec(uid, appid, latest, **kw):
    return {
        "_key": str(uid),
        "app_uid": uid,
        "appid": appid,
        "title": appid,
        "latest_version": latest,
        "release_date": "2026-10-01T09:00:00Z",
        "splunk_versions": "9.3,9.4,10.0",
        "is_archived": False,
        "archive_status": "live",
        "cloud_compatible": True,
        "support": "splunk",
        "app_url": f"https://splunkbase.splunk.com/app/{uid}/",
        "last_checked": CHECKED,
        **kw,
    }


RECORDS = [
    rec(1621, "Splunk_SA_CIM", "6.2.0"),  # installed 5.3.1: newer on Splunkbase
    rec(2686, "splunk_app_db_connect", "4.0.0"),  # installed 4.0: the same version
    rec(1809, "splunk_app_stream", "8.1.10"),  # installed 8.1.9: 10 is more than 9
    rec(3110, "Splunk_TA_microsoft-cloudservices", "5.4.0", is_archived="true"),
    rec(4055, "splunk_ta_o365", "4.6.0", splunk_versions="8.2,9.0", cloud_compatible="0"),
    rec(1876, "Splunk_TA_aws", "7.9.0"),  # not installed here
    rec(9001, "ta-acme", "2.0"),  # installed as TA-acme: matched ignoring case
    rec(1, "dup_app", "1.9", archive_status="archived"),  # an old listing ...
    rec(2, "dup_app", "2.0"),  # ... republished: the live one counts
    rec(3, "beta_app", "1.0.0"),  # installed 1.1.0-beta: newer than Splunkbase's
]
APPS = [
    ("Splunk_SA_CIM", "5.3.1"),
    ("splunk_app_db_connect", "4.0"),
    ("splunk_app_stream", "8.1.9"),
    ("Splunk_TA_microsoft-cloudservices", "5.4.0"),
    ("splunk_ta_o365", "4.5.1"),
    ("TA-acme", "1.0"),
    ("dup_app", "1.5"),
    ("beta_app", "1.1.0-beta"),
    ("search", "9.4.2"),
    ("splunkbase_version_catalog", "2.7.0"),
]


class Mem:
    def __init__(self, records=RECORDS, installed=True):
        self.records = records
        self.installed = installed
        self.pages = 0

    def get(self, path, params=None):
        params = params or {}
        if path == splunkbase.DATA:
            if not self.installed:
                raise EndpointNotFound(path)
            self.pages += 1
            skip = int(params.get("skip", 0))
            return self.records[skip : skip + int(params.get("limit", 10**9))]
        if path == "/services/apps/local":
            entries = [
                {"name": n, "content": {"version": v, "label": n.replace("_", " ")}}
                for n, v in APPS
            ]
            return {"entry": entries, "paging": {"total": len(entries)}}
        if path == "/services/server/info":
            return {"entry": [{"content": {"version": "9.4.2", "serverName": "sh1"}}]}
        raise EndpointNotFound(path)

    def search(self, name, spl, earliest="-24h", latest="now"):
        return []


def build(transport, platform=False):
    result = ExtractResult()
    if platform:  # the platform's own app objects, as a full build makes them
        result.extend(splunk.extract(transport, "s", only={"apps"}))
    result.extend(splunkbase.extract(transport, "s"))
    b = assemble([{"id": "s", "name": "s", "kind": "splunkEnterprise"}], result, NOW)
    apps = {e["name"]: e for e in b["entities"] if e["type"] == "app"}
    return apps, b


def sb(apps, name):
    return apps[name]["properties"]["splunkbase"]


def checks(e):
    return {c["check"]: c["message"] for c in (e.get("health") or {}).get("checks", [])}


def test_matches_installed_apps_and_compares_versions():
    apps, _ = build(Mem())
    assert sb(apps, "Splunk_SA_CIM") == {
        "appId": "Splunk_SA_CIM",
        "uid": 1621,
        "title": "Splunk_SA_CIM",
        "latestVersion": "6.2.0",
        "releaseDate": "2026-10-01T09:00:00Z",
        "updateAvailable": True,
        "archived": False,
        "splunkVersions": ["9.3", "9.4", "10.0"],
        "splunkVersion": "9.4",
        "compatible": True,
        "cloudCompatible": True,
        "support": "splunk",
        "url": "https://splunkbase.splunk.com/app/1621/",
        "lastChecked": "2026-11-25T03:15:00Z",
    }
    assert sb(apps, "splunk_app_db_connect")["updateAvailable"] is False  # 4.0 is 4.0.0
    assert sb(apps, "splunk_app_stream")["updateAvailable"] is True  # 8.1.10 > 8.1.9
    assert sb(apps, "beta_app")["updateAvailable"] is False  # installed is newer
    o365 = sb(apps, "splunk_ta_o365")
    assert (o365["compatible"], o365["cloudCompatible"]) == (False, False)
    assert sb(apps, "TA-acme")["appId"] == "ta-acme"
    assert sb(apps, "dup_app")["latestVersion"] == "2.0"
    assert "Splunk_TA_aws" not in apps  # in the catalogue, not installed
    assert "search" not in apps  # not on Splunkbase: left alone


def test_findings_for_newer_and_archived_apps():
    apps, _ = build(Mem())
    assert checks(apps["Splunk_SA_CIM"]) == {
        "appUpdate": "Splunkbase has version 6.2.0 (released 2026-10-01); this is 5.3.1"
    }
    assert checks(apps["Splunk_TA_microsoft-cloudservices"]) == {
        "appArchived": "Archived on Splunkbase: no longer maintained, so no fixes or security "
        "updates; its last release is 5.4.0"
    }
    assert checks(apps["splunk_app_db_connect"]) == {}
    assert checks(apps["beta_app"]) == {}
    catalog = apps["splunkbase_version_catalog"]
    assert catalog["properties"]["splunkbaseCatalog"] == {
        "apps": len(RECORDS),
        "installedHere": 8,
        "updatesAvailable": 5,
        "archived": 1,
        "lastChecked": "2026-11-25T03:15:00Z",
    }
    assert checks(catalog) == {}  # refreshed this morning


def test_a_catalogue_no_longer_refreshed_is_a_finding():
    old = CHECKED - 5 * 86400
    apps, _ = build(Mem([{**r, "last_checked": old} for r in RECORDS]))
    assert checks(apps["splunkbase_version_catalog"]) == {
        "splunkbaseStale": "Its Splunkbase catalogue was last refreshed 5.4 days ago (it refreshes "
        "daily): newer versions published since are not known"
    }


def test_adds_to_the_platforms_app_objects():
    apps, b = build(Mem(), platform=True)
    cim = apps["Splunk_SA_CIM"]
    assert cim["displayName"] == "Splunk SA CIM"
    assert cim["properties"]["version"] == "5.3.1"
    assert cim["properties"]["splunkbase"]["latestVersion"] == "6.2.0"
    assert len([e for e in b["entities"] if e["id"] == cim["id"]]) == 1
    assert "splunkbase" not in apps["search"]["properties"]  # not on Splunkbase: left alone
    report = {r["connector"]: r for r in b["ingestionReport"]}["splunkbase.versions"]
    assert (report["status"], report["counts"]) == ("ok", {"entities": 8})


def test_reads_the_catalogue_a_page_at_a_time(monkeypatch):
    monkeypatch.setattr(splunkbase, "PAGE", 3)
    t = Mem()
    apps, _ = build(t)
    assert t.pages == 4  # 3 + 3 + 3 + 1 records
    assert sb(apps, "beta_app")["latestVersion"] == "1.0.0"


def test_not_installed_or_an_empty_catalogue_is_skipped():
    _, b = build(Mem(installed=False))
    report = {r["connector"]: r for r in b["ingestionReport"]}["splunkbase.versions"]
    assert report["status"] == "skipped" and "not available" in report["message"]
    assert not [e for e in b["entities"] if (e.get("properties") or {}).get("splunkbase")]

    apps, b = build(Mem(records=[]))
    report = {r["connector"]: r for r in b["ingestionReport"]}["splunkbase.versions"]
    assert report["status"] == "skipped" and "catalogue is empty" in report["message"]
    assert apps["splunkbase_version_catalog"]["properties"]["splunkbaseCatalog"] == {
        "apps": 0,
        "installedHere": 0,
        "updatesAvailable": 0,
        "archived": 0,
    }


@pytest.mark.parametrize(
    ("latest", "installed", "newer"),
    [
        ("1.10", "1.9", True),
        ("2.0", "2.0.0", False),
        ("3.1.0", "3.2", False),
        ("5.0.1", "5.0.0b2", True),
        ("", "1.0", None),
        ("1.0", None, None),
    ],
)
def test_version_comparison(latest, installed, newer):
    assert splunkbase.is_newer(latest, installed) is newer


def test_a_build_part():
    assert "splunkbase" in resolve_parts({"splunkbase"})
