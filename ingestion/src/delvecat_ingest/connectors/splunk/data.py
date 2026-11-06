"""Indexes, observed data inventory (sourcetypes, hosts, sources), inputs and forwarders."""

from __future__ import annotations

from typing import Any

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from ...transport import EndpointForbidden, EndpointNotFound, SearchError
from .common import NS, Ctx, add_global, add_ko, content, epoch_to_iso, ref, split_list, to_int

ALL_INDEXES = "(index=* OR index=_*)"


def extract_indexes(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/data/indexes", {"datatype": "all"}):
        c = content(e)
        add_global(
            ctx,
            out,
            "index",
            e["name"],
            app=(e.get("acl") or {}).get("app"),
            disabled=as_bool(c.get("disabled", False)),
            updatedAt=e.get("updated"),
            properties={
                "datatype": c.get("datatype", "event"),
                "maxTotalDataSizeMB": to_int(c.get("maxTotalDataSizeMB")),
                "frozenTimePeriodInSecs": to_int(c.get("frozenTimePeriodInSecs")),
                "homePath": c.get("homePath") or None,
                "coldToFrozenDir": c.get("coldToFrozenDir") or None,
                "internal": e["name"].startswith("_"),
            },
            observed={
                "currentDBSizeMB": to_int(c.get("currentDBSizeMB")),
                "totalEventCount": to_int(c.get("totalEventCount")),
                "earliestEvent": c.get("minTime") or None,
                "latestEvent": c.get("maxTime") or None,
            },
        )
        n += 1
    return n


def _mv(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    return [value] if value else []


def extract_inventory(ctx: Ctx, out: ExtractResult) -> int:
    """Observed sourcetypes per index over the inventory window (tstats, cheap)."""
    rows = ctx.transport.search(
        "inventory_sourcetypes",
        f"| tstats count min(_time) as firstSeen max(_time) as lastSeen "
        f"where {ALL_INDEXES} by index, sourcetype",
        earliest=ctx.options.inventory_window,
    )
    per_st: dict[str, dict[str, Any]] = {}
    for r in rows:
        st, idx = r.get("sourcetype"), r.get("index")
        if not st or not idx:
            continue
        agg = per_st.setdefault(st, {"count": 0, "indexes": {}, "first": None, "last": None})
        count = to_int(r.get("count")) or 0
        agg["count"] += count
        agg["indexes"][idx] = agg["indexes"].get(idx, 0) + count
        first, last = to_int(r.get("firstSeen")), to_int(r.get("lastSeen"))
        if first is not None:
            agg["first"] = first if agg["first"] is None else min(agg["first"], first)
        if last is not None:
            agg["last"] = last if agg["last"] is None else max(agg["last"], last)
    for st, agg in per_st.items():
        ent = add_global(
            ctx,
            out,
            "sourcetype",
            st,
            observed={
                "eventCount": agg["count"],
                "eventsByIndex": agg["indexes"],
                "firstSeen": epoch_to_iso(agg["first"]),
                "lastSeen": epoch_to_iso(agg["last"]),
                "window": ctx.options.inventory_window,
            },
        )
        out.refs.extend(ref(ent["id"], "index", i, "feeds") for i in agg["indexes"])
    return len(per_st)


def _observed_dimension(ctx: Ctx, out: ExtractResult, dim: str, limit: int) -> int:
    rows = ctx.transport.search(
        f"inventory_{dim}s",
        f"| tstats count max(_time) as lastSeen where {ALL_INDEXES} by {dim}, index "
        f"| stats sum(count) as count max(lastSeen) as lastSeen values(index) as indexes by {dim} "
        f"| sort 0 - count | head {limit}",
        earliest=ctx.options.inventory_window,
    )
    n = 0
    for r in rows:
        name = r.get(dim)
        if not name:
            continue
        indexes = _mv(r.get("indexes"))
        ent = add_global(
            ctx,
            out,
            dim,
            name,
            observed={
                "eventCount": to_int(r.get("count")),
                "lastSeen": epoch_to_iso(r.get("lastSeen")),
                "indexes": indexes,
                "window": ctx.options.inventory_window,
            },
        )
        out.refs.extend(ref(ent["id"], "index", i, "feeds") for i in indexes)
        n += 1
    return n


def extract_hosts(ctx: Ctx, out: ExtractResult) -> int:
    return _observed_dimension(ctx, out, "host", ctx.options.max_hosts)


def extract_sources(ctx: Ctx, out: ExtractResult) -> int:
    return _observed_dimension(ctx, out, "source", ctx.options.max_sources)


# Input endpoints on this instance (search heads usually have few; heavy forwarders many).
INPUT_ENDPOINTS = {
    "monitor": "data/inputs/monitor",
    "tcp": "data/inputs/tcp/raw",
    "splunktcp": "data/inputs/tcp/cooked",
    "udp": "data/inputs/udp",
    "script": "data/inputs/script",
    "http": "data/inputs/http",
}


def extract_inputs(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for kind, path in INPUT_ENDPOINTS.items():
        try:
            entries = list(iter_entries(ctx.transport, f"{NS}/{path}"))
        except (EndpointNotFound, EndpointForbidden):
            continue
        for e in entries:
            c = content(e)
            name = e["name"]
            if kind == "http" and name.startswith("http://"):
                name = name[len("http://") :]
            ent = add_ko(
                ctx,
                out,
                "input",
                e,
                name=f"{kind}://{name}",
                properties={
                    "kind": kind,
                    "index": c.get("index") or None,
                    "allowedIndexes": split_list(c.get("indexes")),
                    "sourcetype": c.get("sourcetype") or None,
                    "host": c.get("host") or None,
                    "source": c.get("source") or None,
                    "interval": c.get("interval") or None,
                    "useAck": as_bool(c.get("useACK", False)) if kind == "http" else None,
                },
            )
            index = c.get("index")
            targets = {index if index and index != "default" else "main"}
            targets.update(split_list(c.get("indexes")))
            out.refs.extend(ref(ent["id"], "index", i, "feeds") for i in sorted(targets))
            if c.get("sourcetype"):
                out.refs.append(ref(ent["id"], "sourcetype", c["sourcetype"], "feeds"))
            n += 1
    return n


def extract_forwarders(ctx: Ctx, out: ExtractResult) -> int:
    """Forwarders seen connecting to this instance's indexers (from _internal metrics)."""
    rows = ctx.transport.search(
        "forwarders",
        "index=_internal sourcetype=splunkd group=tcpin_connections "
        "| stats latest(_time) as lastSeen latest(fwdType) as fwdType latest(version) as version "
        "latest(os) as os latest(arch) as arch sum(kb) as kb by hostname "
        f"| sort 0 - kb | head {ctx.options.max_forwarders}",
        earliest="-24h",
    )
    n = 0
    for r in rows:
        if not r.get("hostname"):
            continue
        add_global(
            ctx,
            out,
            "forwarder",
            r["hostname"],
            properties={
                "fwdType": r.get("fwdType"),
                "version": r.get("version"),
                "os": r.get("os"),
                "arch": r.get("arch"),
            },
            observed={
                "lastSeen": epoch_to_iso(r.get("lastSeen")),
                "kbReceived24h": to_int(r.get("kb")),
            },
        )
        n += 1
    return n


_SKIP_FIELDS = frozenset(
    {
        "date_hour",
        "date_mday",
        "date_minute",
        "date_month",
        "date_second",
        "date_wday",
        "date_year",
        "date_zone",
        "timestartpos",
        "timeendpos",
        "linecount",
        "punct",
        "splunk_server",
        "splunk_server_group",
        # default metadata fields: present on every event, so coverage says nothing
        "host",
        "index",
        "source",
        "sourcetype",
    }
)


def extract_fields(ctx: Ctx, out: ExtractResult) -> int:
    """Opt-in: sample events per observed sourcetype and summarize their fields."""
    if not ctx.options.fields:
        return 0

    def rank(e: dict[str, Any]) -> tuple[bool, int]:
        obs = e["properties"]["observed"]
        internal_only = all(i.startswith("_") for i in obs.get("eventsByIndex", {}))
        return (internal_only, -obs["eventCount"])  # customer data first, then by volume

    sourcetypes = sorted(
        (
            e
            for e in out.entities
            if e["type"] == "sourcetype"
            and (e.get("properties", {}).get("observed") or {}).get("eventCount")
        ),
        key=rank,
    )[: ctx.options.max_field_sourcetypes]
    n = 0
    failed: list[str] = []
    for st in sourcetypes:
        name = st["name"].replace('"', '\\"')
        try:
            rows = ctx.transport.search(
                f"fieldsummary/{st['name']}",
                f'{ALL_INDEXES} sourcetype="{name}" | head {ctx.options.field_sample_events} '
                "| fieldsummary maxvals=0 | fields field count distinct_count numeric_count",
                earliest=ctx.options.inventory_window,
            )
        except (EndpointNotFound, EndpointForbidden, SearchError) as exc:
            failed.append(f"{st['name']} ({type(exc).__name__})")
            continue
        sampled = max((to_int(r.get("count")) or 0 for r in rows), default=0) or 1
        for r in rows:
            fname = r.get("field")
            if not fname or fname in _SKIP_FIELDS or fname.startswith("_"):
                continue
            count = to_int(r.get("count")) or 0
            if count == 0:
                continue
            ent = add_global(
                ctx,
                out,
                "field",
                f"{st['name']}/{fname}",
                displayName=fname,
                properties={
                    "sourcetype": st["name"],
                    "field": fname,
                    "numeric": count > 0 and to_int(r.get("numeric_count")) == count,
                },
                observed={
                    "coverage": round(count / sampled, 3),
                    "distinctCount": to_int(r.get("distinct_count")),
                },
            )
            out.edges.append(
                {"from": st["id"], "to": ent["id"], "type": "contains", "origin": "connector"}
            )
            n += 1
    if failed:
        shown = ", ".join(failed[:5]) + (f" and {len(failed) - 5} more" if len(failed) > 5 else "")
        return n, f"{len(failed)} of {len(sourcetypes)} sourcetypes could not be sampled: {shown}"
    return n
