"""Splunkbase versions of the installed apps, from the Splunkbase Version Catalog app.

The app ``splunkbase_version_catalog`` refreshes a KV store collection,
``splunkbase_catalog``, once a day with the latest Splunkbase release of the apps it
tracks: version, release date, the Splunk versions it lists as compatible, Cloud
compatibility and whether the app is archived on Splunkbase (no longer maintained). One
record per Splunkbase app, keyed by its numeric id.

This reads that collection (read-only, through the generic KV store REST API, with the
builder's permissions) and matches it to the apps installed here the way that app does:
an installed app's folder name is the Splunkbase app id (``appid``), compared exactly and
then ignoring case. Apps that match nothing are left alone.

A matched app gains ``properties.splunkbase``: the release facts, whether Splunkbase has
a newer version (compared number by number: 1.10 is newer than 1.9, 2.0 is 2.0.0) and
whether this Splunk's version is among the compatible ones. The Splunkbase Version
Catalog app itself records how many apps its catalogue holds, how many are installed
here and when it last refreshed. The health checks turn these into findings: a newer
version on Splunkbase, an app archived on Splunkbase, a catalogue no longer refreshed.
"""

from __future__ import annotations

import re
from typing import Any

from ..model import ExtractResult
from ..splunk_rest import as_bool, iter_entries
from ..transport import EndpointNotFound
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, content, epoch_to_iso, to_int

APP = "splunkbase_version_catalog"
COLLECTION = "splunkbase_catalog"
DATA = f"/servicesNS/nobody/{APP}/storage/collections/data/{COLLECTION}"
PAGE = 10000  # records per request (the KV store returns at most 50,000 by default)
MAX_RECORDS = 200_000  # far beyond Splunkbase's listing: a guard against a loop


def _records(ctx: Ctx) -> list[dict[str, Any]]:
    """Every record of the catalogue, a page at a time."""
    out: list[dict[str, Any]] = []
    while len(out) < MAX_RECORDS:
        body = ctx.transport.get(DATA, {"limit": PAGE, "skip": len(out)})
        batch = [d for d in body if isinstance(d, dict)] if isinstance(body, list) else []
        out.extend(batch)
        if len(batch) < PAGE:
            break
    return out


def version_key(version: Any) -> list[int] | None:
    """The numbers in a version ("1.10.2" -> [1, 10, 2]); None without any."""
    nums = re.findall(r"\d+", str(version or ""))
    return [int(n) for n in nums] if nums else None


def is_newer(latest: Any, installed: Any) -> bool | None:
    """Whether ``latest`` is a later version than ``installed`` (None: cannot tell)."""
    a, b = version_key(latest), version_key(installed)
    if a is None or b is None:
        return None
    n = max(len(a), len(b))
    return a + [0] * (n - len(a)) > b + [0] * (n - len(b))


def major_minor(version: Any) -> str | None:
    m = re.match(r"\s*(\d+)\.(\d+)", str(version or ""))
    return f"{m[1]}.{m[2]}" if m else None


def _archived(rec: dict[str, Any]) -> bool:
    return as_bool(rec.get("is_archived")) or str(rec.get("archive_status") or "").lower() == (
        "archived"
    )


def _pick(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Of several records with one app id (a listing republished under a new number), the
    live one with the latest release."""
    return max(
        records,
        key=lambda r: (
            not _archived(r),
            str(r.get("release_date") or ""),
            to_int(r.get("app_uid")) or 0,
        ),
    )


def _facts(rec: dict[str, Any], installed: str | None, splunk: str | None) -> dict[str, Any]:
    latest = str(rec.get("latest_version") or "") or None
    listed = [v.strip() for v in str(rec.get("splunk_versions") or "").split(",") if v.strip()]
    this = major_minor(splunk)
    compatible = this in {major_minor(v) or v for v in listed} if listed and this else None
    facts = {
        "appId": rec.get("appid") or None,
        "uid": to_int(rec.get("app_uid")) or to_int(rec.get("_key")),
        "title": rec.get("title") or None,
        "latestVersion": latest,
        "releaseDate": rec.get("release_date") or None,
        "updateAvailable": is_newer(latest, installed) if latest else None,
        "archived": _archived(rec),
        "splunkVersions": listed or None,
        "splunkVersion": this if listed else None,
        "compatible": compatible,
        "cloudCompatible": as_bool(rec.get("cloud_compatible")),
        "support": rec.get("support") or None,
        "url": rec.get("app_url") or None,
        "lastChecked": epoch_to_iso(rec.get("last_checked")),
    }
    return {k: v for k, v in facts.items() if v is not None}


def extract_versions(ctx: Ctx, out: ExtractResult) -> int:
    records = _records(ctx)  # not installed: the collection is not there (skipped)
    by_id: dict[str, list[dict[str, Any]]] = {}
    for r in records:
        if r.get("appid"):
            by_id.setdefault(str(r["appid"]), []).append(r)
    by_lower: dict[str, list[str]] = {}
    for appid in by_id:
        by_lower.setdefault(appid.lower(), []).append(appid)
    info = ctx.transport.get("/services/server/info")
    splunk = (
        content((info.get("entry") or [{}])[0]).get("version") if isinstance(info, dict) else None
    )

    matched = updates = archived = 0
    catalog_app: dict[str, Any] | None = None
    for e in iter_entries(ctx.transport, "/services/apps/local"):
        c = content(e)
        name = e["name"]
        if name == APP:
            catalog_app = c
        appid = name if name in by_id else None
        if appid is None and len(same := by_lower.get(name.lower(), [])) == 1:
            appid = same[0]
        if appid is None:
            continue
        facts = _facts(_pick(by_id[appid]), c.get("version"), splunk)
        add_global(
            ctx,
            out,
            "app",
            name,
            displayName=c.get("label"),
            properties={"version": c.get("version"), "splunkbase": facts},
        )
        matched += 1
        updates += bool(facts.get("updateAvailable"))
        archived += bool(facts.get("archived"))

    # The catalogue's own summary, on the Splunkbase Version Catalog app.
    checked = max((to_int(r.get("last_checked")) or 0 for r in records), default=0)
    summary = {
        "apps": len(records),
        "installedHere": matched,
        "updatesAvailable": updates,
        "archived": archived,
        "lastChecked": epoch_to_iso(checked) if checked else None,
    }
    if catalog_app is not None:
        add_global(
            ctx,
            out,
            "app",
            APP,
            displayName=catalog_app.get("label"),
            properties={
                "version": catalog_app.get("version"),
                "splunkbaseCatalog": {k: v for k, v in summary.items() if v is not None},
            },
        )
    if not records:  # installed, but its input has not run: nothing to compare with
        raise EndpointNotFound(
            "the Splunkbase Version Catalog app's catalogue is empty (enable its input)"
        )
    return matched


EXTRACTORS = {"versions": extract_versions}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "splunkbase", out)
    return out
