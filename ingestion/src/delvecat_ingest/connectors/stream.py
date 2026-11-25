"""Splunk Stream connector.

Stream keeps its configuration in KV store collections of ``splunk_app_stream``
(``streams`` and ``streamforwardergroups``), read through the generic KV store
REST API. Forwarders are observed from the data: hosts sending ``stream:*``
sourcetypes. Field names follow the Stream app's stored documents and should be
re-checked against each Stream release.

A stream writes the sourcetype ``stream:<stream id>`` (an aggregated stream ``http_slow``
on protocol http writes ``stream:http_slow``). A stream sends data only while it is
enabled, not in estimate mode (``sendToIndexer`` false) and, for an ephemeral capture,
not past its expiry. Its filters and aggregation say what it captures. Groups naming a
stream that does not exist, streams no forwarder sends, and forwarders not sending the
streams their groups deploy are recorded for the health checks.
"""

from __future__ import annotations

import re
import time

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


def _filters(d: dict) -> dict | None:
    f = d.get("filters") or {}
    comps = [
        f"{c.get('term')} {c.get('comparisonType') or '='} {c.get('value')}".strip()
        for c in f.get("comparisons") or []
        if isinstance(c, dict) and c.get("term")
    ]
    if not comps:
        return None
    return {"match": "all" if f.get("matchAllComparisons", True) else "any", "rules": comps}


def _aggregation(fields: list) -> dict | None:
    keys = [f["name"] for f in fields if f.get("aggType") == "key"]
    measures = [
        f"{f['aggType']}({f['name']})"
        for f in fields
        if f.get("aggType") and f.get("aggType") != "key"
    ]
    return {"keys": keys, "measures": measures} if keys or measures else None


def extract_streams(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    now = time.time()
    for d in _docs(ctx, "streams"):
        name = d.get("id") or d.get("_key")
        if not name:
            continue
        protocol = d.get("protocolName") or name
        enabled = as_bool(d.get("enabled", False))
        estimate = "sendToIndexer" in d and not as_bool(d.get("sendToIndexer"))
        expires = to_int(d.get("expirationDate"))
        expired = bool(expires) and expires < now
        sends = enabled and not estimate and not expired
        index = d.get("index") or "main"
        fields = [f for f in d.get("fields") or [] if isinstance(f, dict) and f.get("enabled")]
        sourcetype = f"stream:{name}"
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
                "sourcetype": sourcetype,
                "mode": "estimate" if estimate and enabled else None,
                "ephemeral": True if expires else None,
                "expiresAt": epoch_to_iso(expires) if expires else None,
                "expired": True if expired else None,
                "createdBy": d.get("appName") if d.get("appName") not in (None, "Stream") else None,
                "sendsData": sends,
                "filters": _filters(d),
                "aggregation": _aggregation(fields),
                "fields": [f["name"] for f in fields if f.get("name")],
            },
        )
        if sends:
            out.refs.append(ref(ent["id"], "index", index, "feeds"))
            out.refs.append(ref(ent["id"], "sourcetype", sourcetype, "feeds"))
        n += 1
    return n


def extract_groups(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for d in _docs(ctx, "streamforwardergroups"):
        name = d.get("name") or d.get("_key")
        if not name:
            continue
        defined = {e["name"] for e in out.entities if e["type"] == "streamDefinition"}
        missing = [x for x in d.get("streams") or [] if x not in defined] if defined else []
        ent = add_global(
            ctx,
            out,
            "streamGroup",
            name,
            product=PRODUCT,
            app=APP,
            description=d.get("description") or None,
            properties={
                "rule": d.get("rule") or None,
                "streams": list(d.get("streams") or []),
                "missingStreams": missing or None,
            },
        )
        out.edges.extend(
            edge(ent["id"], fqn(ctx.instance, "streamDefinition", s), "deploys")
            for s in d.get("streams") or []
            if s not in missing
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
    streams = {e["name"]: e for e in out.entities if e["type"] == "streamDefinition"}
    seen_types = {st for h in hosts.values() for st in h["sourcetypes"]}
    if hosts:  # only when Stream data is searchable here
        for s in streams.values():
            p = s.get("properties") or {}
            if p.get("sendsData"):
                p["observedSending"] = p.get("sourcetype") in seen_types
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
        expected: set[str] = set()
        for g in groups:
            gp = g.get("properties") or {}
            rule = gp.get("rule")
            try:
                if not (rule and re.fullmatch(rule, host)):
                    continue
            except re.error:
                continue
            out.edges.append(edge(g["id"], ent["id"], "deploys"))
            for sname in gp.get("streams") or []:
                sp = (streams.get(sname) or {}).get("properties") or {}
                # a filtered stream only sends matching traffic: quiet can be normal
                if sp.get("sendsData") and not sp.get("filters"):
                    expected.add(sname)
        missing = sorted(x for x in expected if f"stream:{x}" not in h["sourcetypes"])
        if missing:
            ent.setdefault("properties", {})["notSending"] = missing
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
