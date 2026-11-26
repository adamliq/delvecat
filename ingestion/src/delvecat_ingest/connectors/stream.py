"""Splunk Stream connector.

Stream keeps its configuration in KV store collections of ``splunk_app_stream``
(``streams`` and ``streamforwardergroups``), read through the generic KV store
REST API. Forwarders are observed from the data: hosts sending ``stream:*``
sourcetypes. Field names follow the Stream app's stored documents and should be
re-checked against each Stream release.
"""

from __future__ import annotations

import re

from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, epoch_to_iso, ref, to_int

APP = "splunk_app_stream"
PRODUCT = "stream"
KV = f"/servicesNS/nobody/{APP}/storage/collections/data"


def _docs(ctx: Ctx, collection: str) -> list[dict]:
    body = ctx.transport.get(f"{KV}/{collection}")
    return body if isinstance(body, list) else []


def extract_streams(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for d in _docs(ctx, "streams"):
        name = d.get("id") or d.get("_key")
        if not name:
            continue
        protocol = d.get("protocolName") or name
        enabled = as_bool(d.get("enabled", False))
        index = d.get("index") or "main"
        ent = add_global(
            ctx,
            out,
            "streamDefinition",
            name,
            product=PRODUCT,
            app=APP,
            disabled=not enabled,
            description=d.get("description") or None,
            properties={
                "protocol": protocol,
                "streamType": d.get("streamType"),
                "category": d.get("category") or None,
                "index": index if enabled else d.get("index"),
                "sourcetype": f"stream:{protocol}",
                "fields": [
                    f.get("name")
                    for f in d.get("fields") or []
                    if f.get("enabled") and f.get("name")
                ],
            },
        )
        if enabled:
            out.refs.append(ref(ent["id"], "index", index, "feeds"))
            out.refs.append(ref(ent["id"], "sourcetype", f"stream:{protocol}", "feeds"))
        n += 1
    return n


def extract_groups(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for d in _docs(ctx, "streamforwardergroups"):
        name = d.get("name") or d.get("_key")
        if not name:
            continue
        ent = add_global(
            ctx,
            out,
            "streamGroup",
            name,
            product=PRODUCT,
            app=APP,
            description=d.get("description") or None,
            properties={"rule": d.get("rule") or None, "streams": list(d.get("streams") or [])},
        )
        out.edges.extend(
            edge(ent["id"], fqn(ctx.instance, "streamDefinition", s), "deploys")
            for s in d.get("streams") or []
        )
        n += 1
    return n


def extract_forwarders(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "stream_forwarders",
        "| tstats count max(_time) as lastSeen where (index=* OR index=_*) sourcetype=stream:* "
        "by host, sourcetype, index",
        earliest="-7d",
    )
    hosts: dict[str, dict] = {}
    for r in rows:
        if not r.get("host"):
            continue
        h = hosts.setdefault(
            r["host"], {"sourcetypes": set(), "indexes": set(), "last": 0, "count": 0}
        )
        h["sourcetypes"].add(r.get("sourcetype"))
        h["indexes"].add(r.get("index"))
        h["last"] = max(h["last"], to_int(r.get("lastSeen")) or 0)
        h["count"] += to_int(r.get("count")) or 0
    groups = [e for e in out.entities if e["type"] == "streamGroup"]
    for host, h in hosts.items():
        ent = add_global(
            ctx,
            out,
            "streamForwarder",
            host,
            product=PRODUCT,
            properties={"hostname": host},
            observed={
                "sourcetypes": sorted(filter(None, h["sourcetypes"])),
                "indexes": sorted(filter(None, h["indexes"])),
                "lastSeen": epoch_to_iso(h["last"]),
                "eventCount": h["count"],
                "window": "-7d",
            },
        )
        for g in groups:
            rule = (g.get("properties") or {}).get("rule")
            try:
                if rule and re.fullmatch(rule, host):
                    out.edges.append(edge(g["id"], ent["id"], "deploys"))
            except re.error:
                continue
    return len(hosts)


EXTRACTORS = {
    "streams": extract_streams,
    "groups": extract_groups,
    "forwarders": extract_forwarders,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "stream", out)
    return out
