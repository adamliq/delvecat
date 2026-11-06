"""Splunk Cloud Admin Config Service (ACS) connector.

Base URL: ``https://admin.splunk.com/<stack>/adminconfig/v2``. Enriches the
REST inventory with Cloud-managed settings (index retention, HEC tokens,
installed apps, IP allow lists). HEC token values are never collected.
"""

from __future__ import annotations

from typing import Any

from ..model import ExtractResult, fqn
from ..transport import EndpointForbidden, EndpointNotFound, Transport
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, add_ko, ref, to_int

ACS_BASE = "https://admin.splunk.com/{stack}/adminconfig/v2"
IP_ALLOWLIST_FEATURES = ("search-api", "hec", "s2s", "search-ui", "idm-api", "idm-ui", "acs")
PAGE = 100


def _paged(t: Transport, path: str, key: str | None = None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    while True:
        body = t.get(path, {"offset": offset, "count": PAGE})
        page = body if isinstance(body, list) else body.get(key or "", [])
        new = [i for i in page if _name(i) not in seen]
        items.extend(new)
        seen.update(_name(i) for i in new)
        if len(page) < PAGE or not new:
            return items
        offset += len(page)


def _name(item: dict[str, Any]) -> str:
    return str(item.get("name") or (item.get("spec") or {}).get("name"))


def extract_indexes(ctx: Ctx, out: ExtractResult) -> int:
    rows = _paged(ctx.transport, "/indexes")
    for r in rows:
        add_global(
            ctx,
            out,
            "index",
            r["name"],
            properties={
                "datatype": r.get("datatype"),
                "searchableDays": to_int(r.get("searchableDays")),
                "maxDataSizeMB": to_int(r.get("maxDataSizeMB")),
                "splunkArchivalRetentionDays": to_int(r.get("splunkArchivalRetentionDays")),
                "selfStorageBucketPath": r.get("selfStorageBucketPath") or None,
                "internal": r["name"].startswith("_"),
            },
            observed={
                "totalEventCount": to_int(r.get("totalEventCount")),
                "totalRawSizeMB": to_int(r.get("totalRawSizeMB")),
            },
        )
    return len(rows)


def extract_hec_tokens(ctx: Ctx, out: ExtractResult) -> int:
    rows = _paged(ctx.transport, "/inputs/http-event-collectors", "http-event-collectors")
    for r in rows:
        spec = r.get("spec") or r
        entry = {
            "name": spec["name"],
            "acl": {"app": "splunk_httpinput", "owner": "nobody", "sharing": "app"},
            "content": {"disabled": spec.get("disabled", False)},
        }
        ent = add_ko(
            ctx,
            out,
            "input",
            entry,
            name=f"http://{spec['name']}",
            properties={
                "kind": "http",
                "index": spec.get("defaultIndex"),
                "allowedIndexes": spec.get("allowedIndexes") or [],
                "sourcetype": spec.get("defaultSourcetype"),
                "source": spec.get("defaultSource"),
                "host": spec.get("defaultHost"),
                "useAck": spec.get("useAck"),
                "managedBy": "acs",
            },
        )
        targets = {spec.get("defaultIndex") or "main", *(spec.get("allowedIndexes") or [])}
        out.refs.extend(ref(ent["id"], "index", i, "feeds") for i in sorted(targets))
        if spec.get("defaultSourcetype"):
            out.refs.append(ref(ent["id"], "sourcetype", spec["defaultSourcetype"], "feeds"))
    return len(rows)


def extract_apps(ctx: Ctx, out: ExtractResult) -> int:
    rows = _paged(ctx.transport, "/apps/victoria", "apps")
    for r in rows:
        add_global(
            ctx,
            out,
            "app",
            r["name"],
            displayName=r.get("label"),
            properties={
                "version": r.get("version"),
                "acsStatus": r.get("status"),
                "splunkbaseId": r.get("splunkbaseID") or r.get("appID"),
            },
        )
    return len(rows)


def extract_ip_allowlists(ctx: Ctx, out: ExtractResult) -> int:
    """Only the number of subnets per feature is recorded, not the subnets themselves."""
    counts: dict[str, int] = {}
    for feature in IP_ALLOWLIST_FEATURES:
        try:
            body = ctx.transport.get(f"/access/{feature}/ipallowlists")
        except (EndpointNotFound, EndpointForbidden):
            continue
        counts[feature] = len(body.get("subnets") or [])
    out.instance_facts.setdefault("properties", {})["ipAllowlistSubnetCounts"] = counts
    out.instance_facts["kind"] = "splunkCloud"
    return len(counts)


EXTRACTORS = {
    "indexes": extract_indexes,
    "hecTokens": extract_hec_tokens,
    "apps": extract_apps,
    "ipAllowlists": extract_ip_allowlists,
}


def extract(transport: Transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "acs", out)
    return out


__all__ = ["ACS_BASE", "extract", "fqn"]
