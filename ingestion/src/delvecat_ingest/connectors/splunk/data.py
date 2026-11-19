"""Indexes, observed data inventory (sourcetypes, hosts, sources), inputs and forwarders."""

from __future__ import annotations

import fnmatch
import re
from typing import Any

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from ...transport import EndpointForbidden, EndpointNotFound, SearchError
from .common import NS, Ctx, add_global, add_ko, content, epoch_to_iso, ref, split_list, to_int

ALL_INDEXES = "(index=* OR index=_*)"
INDEX_PATTERN = re.compile(r"^[A-Za-z0-9_*-]+$")  # index names, with * wildcards


def parse_index_list(text: str | None) -> tuple[str, ...] | None:
    """'web, main , app_*' -> ('web', 'main', 'app_*'); empty -> None (all indexes)."""
    names = tuple(dict.fromkeys(p.strip() for p in (text or "").split(",") if p.strip()))
    if bad := [n for n in names if not INDEX_PATTERN.match(n)]:
        raise ValueError(f"invalid index name(s): {', '.join(bad)} (letters, digits, _ - and *)")
    return names or None


MAX_SAMPLE_INDEXES = 50  # beyond this, a field sample searches all indexes instead


def _mb(value: Any) -> float | None:
    """A size in MB as Splunk writes it ("0.082", 12, "") -> 0.08; 0 caps mean none."""
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _cap(value: Any) -> int | None:
    """A size limit: 0 or empty means no limit of its own."""
    n = to_int(value)
    return n if n else None


def _bucket_dirs(ctx: Ctx) -> dict[str, dict[str, Any]]:
    """Actual size and buckets per tier (data/indexes-extended), when Splunk offers it."""
    try:
        entries = iter_entries(
            ctx.transport, "/services/data/indexes-extended", {"datatype": "all"}
        )
        return {e["name"]: content(e).get("bucket_dirs") or {} for e in entries}
    except (EndpointNotFound, EndpointForbidden):
        return {}


def _dir_stats(d: Any) -> dict[str, Any]:
    """{'bucket_count': '3', 'bucket_size': '12.5'} (or cold_/warm_ prefixed) -> numbers."""
    if not isinstance(d, dict):
        return {}
    buckets = sum(to_int(v) or 0 for k, v in d.items() if k.endswith("bucket_count"))
    size = sum(_mb(v) or 0 for k, v in d.items() if k.endswith("bucket_size") or k == "size")
    return {"buckets": buckets, "sizeMB": round(size, 2)}


def index_storage(c: dict[str, Any], dirs: dict[str, Any]) -> dict[str, Any]:
    """Where an index keeps its data, tier by tier, and what happens to it when it
    freezes. Tiers use Splunk Enterprise's names (hot, warm, cold, frozen, thawed);
    the web app also shows Splunk Cloud's (searchable storage, Active Archive, Self
    Storage)."""
    remote = c.get("remotePath") or None
    home, cold, thawed = (_dir_stats(dirs.get(k)) for k in ("home", "cold", "thawed"))
    home_raw = dirs.get("home") if isinstance(dirs.get("home"), dict) else {}
    tiers: list[dict[str, Any]] = [
        {
            "tier": "hot",
            "path": c.get("homePath") or None,
            "buckets": to_int(home_raw.get("hot_bucket_count")),
            "maxBuckets": to_int(c.get("maxHotBuckets")),  # "auto" -> None
        },
        {
            "tier": "warm",
            # SmartStore: warm buckets live in the remote store, cached locally.
            "path": remote or c.get("homePath") or None,
            "remote": True if remote else None,
            "buckets": to_int(home_raw.get("warm_bucket_count")),
            "sizeMB": _mb(home_raw.get("warm_bucket_size")),
            "maxBuckets": to_int(c.get("maxWarmDBCount")),
        },
    ]
    # hot + warm share homePath and its cap
    tiers[0]["maxSizeMB"] = tiers[1]["maxSizeMB"] = _cap(c.get("homePath.maxDataSizeMB"))
    if not remote:  # SmartStore has no cold tier of its own
        tiers.append(
            {
                "tier": "cold",
                "path": c.get("coldPath") or None,
                "maxSizeMB": _cap(c.get("coldPath.maxDataSizeMB")),
                **({k: v for k, v in cold.items()} if cold else {}),
            }
        )
    frozen = frozen_action(c)
    tiers.append({"tier": "frozen", **frozen})
    tiers.append({"tier": "thawed", "path": c.get("thawedPath") or None, **thawed})
    return {
        "model": "smartStore" if remote else "classic",
        "tiers": [{k: v for k, v in t.items() if v is not None} for t in tiers],
        "maxDataSize": c.get("maxDataSize") or None,  # bucket size: auto, auto_high_volume, MB
        "oldestEventInHome": epoch_to_iso(home_raw.get("event_min_time")),
        "homeSizeMB": home.get("sizeMB"),
    }


def frozen_action(c: dict[str, Any]) -> dict[str, Any]:
    """What happens to data older than the retention period (or over the size limit):
    deleted, archived to a directory or by a script, or, in Splunk Cloud, kept in
    Dynamic Data Active Archive (DDAA) or the customer's own Self Storage (DDSS)."""
    if c.get("archiver.selfStorageProvider") or c.get("archiver.selfStorageBucketPath"):
        return {
            "action": "selfStorage",
            "provider": c.get("archiver.selfStorageProvider") or None,
            "path": c.get("archiver.selfStorageBucketPath") or None,
        }
    if as_bool(c.get("archiver.enableDataArchive", False)) or c.get("archiver.coldStorageProvider"):
        days = to_int(c.get("archiver.coldStorageRetentionPeriod")) or to_int(
            c.get("archiver.maxDataArchiveRetentionPeriod")
        )
        return {
            "action": "activeArchive",
            "provider": c.get("archiver.coldStorageProvider") or None,
            "archiveRetentionDays": days,
        }
    if c.get("coldToFrozenDir"):
        return {"action": "archiveDir", "path": c["coldToFrozenDir"]}
    if c.get("coldToFrozenScript"):
        return {"action": "archiveScript", "path": c["coldToFrozenScript"]}
    return {"action": "delete"}


def extract_indexes(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    dirs = _bucket_dirs(ctx)
    for e in iter_entries(ctx.transport, "/services/data/indexes", {"datatype": "all"}):
        c = content(e)
        frozen_secs = to_int(c.get("frozenTimePeriodInSecs"))
        storage = index_storage(c, dirs.get(e["name"]) or {})
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
                # Retention: data freezes when it is older than retentionDays or the index
                # is over maxTotalDataSizeMB, whichever comes first. Splunk Cloud calls the
                # first "searchable retention".
                "retentionDays": round(frozen_secs / 86400, 1) if frozen_secs else None,
                "maxTotalDataSizeMB": to_int(c.get("maxTotalDataSizeMB")),
                "maxGlobalDataSizeMB": _cap(c.get("maxGlobalDataSizeMB")),  # SmartStore
                "frozenTimePeriodInSecs": frozen_secs,
                "frozenAction": storage["tiers"][-2]["action"],
                "homePath": c.get("homePath") or None,
                "coldPath": c.get("coldPath") or None,
                "remotePath": c.get("remotePath") or None,
                "coldToFrozenDir": c.get("coldToFrozenDir") or None,
                "storage": storage,
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


def _hec_global(ctx: Ctx, out: ExtractResult) -> bool:
    """HTTP Event Collector's own settings (the [http] stanza): on or off for the whole
    instance, port and SSL. Recorded on the instance; returns whether HEC is on."""
    try:
        entries = list(iter_entries(ctx.transport, "/services/data/inputs/http/http"))
    except (EndpointNotFound, EndpointForbidden):
        return True  # unknown: judge each token by its own setting only
    if not entries:
        return True
    c = content(entries[0])
    enabled = not as_bool(c.get("disabled", False))
    out.instance_facts.setdefault("properties", {})["httpEventCollector"] = {
        "enabled": enabled,
        "port": to_int(c.get("port")),
        "ssl": as_bool(c.get("enableSSL", True)),
    }
    return enabled


def extract_inputs(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    hec_on = _hec_global(ctx, out)
    for kind, path in INPUT_ENDPOINTS.items():
        try:
            entries = list(iter_entries(ctx.transport, f"{NS}/{path}"))
        except (EndpointNotFound, EndpointForbidden):
            continue
        for e in entries:
            c = content(e)
            name = e["name"]
            if kind == "http" and name == "http":
                continue  # the global [http] stanza, read above
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
                    # HEC tokens: where events go, and whether HEC itself is on. The token
                    # value is never read into the catalog.
                    "outputGroup": (c.get("outputgroup") or None) if kind == "http" else None,
                    "hecEnabled": hec_on if kind == "http" else None,
                },
            )
            # A disabled input, or a token while HEC is off, feeds nothing.
            if not ent.get("disabled") and (kind != "http" or hec_on):
                index = c.get("index")
                targets = {index if index and index != "default" else "main"}
                targets.update(split_list(c.get("indexes")))
                out.refs.extend(ref(ent["id"], "index", i, "feeds") for i in sorted(targets))
                if c.get("sourcetype"):
                    out.refs.append(ref(ent["id"], "sourcetype", c["sourcetype"], "feeds"))
            n += 1
    return n


# Input kinds Splunk has no REST endpoint list for (or only on Windows): read from
# inputs.conf itself. "fschange" stanzas are written "fschange:<path>".
CONF_INPUT_KINDS = (
    "batch",
    "WinEventLog",
    "perfmon",
    "WinRegMon",
    "admon",
    "WinHostMon",
    "WinNetMon",
    "WinPrintMon",
    "powershell",
    "powershell2",
    "splunktcp-ssl",
    "tcp-ssl",
    "fschange",
)


def _conf_inputs(ctx: Ctx) -> list[dict[str, Any]]:
    if "conf-inputs" not in ctx.cache:
        try:
            ctx.cache["conf-inputs"] = list(
                iter_entries(ctx.transport, f"{NS}/configs/conf-inputs")
            )
        except (EndpointNotFound, EndpointForbidden):
            ctx.cache["conf-inputs"] = []
    return ctx.cache["conf-inputs"]


def extract_conf_inputs(ctx: Ctx, out: ExtractResult) -> int:
    """Batch, Windows (event logs, perfmon, registry, AD, host, network, print),
    PowerShell, SSL and file-change inputs, from inputs.conf."""
    n = 0
    seen: set[tuple[str | None, str]] = set()
    for e in _conf_inputs(ctx):
        stanza = e["name"]
        kind, sep, target = stanza.partition("://")
        if not sep and stanza.startswith("fschange:"):
            kind, target = "fschange", stanza[len("fschange:") :]
        if kind not in CONF_INPUT_KINDS or not target:
            continue
        name = f"{kind}://{target}"
        app = (e.get("acl") or {}).get("app")
        if (app, name) in seen:
            continue
        seen.add((app, name))
        c = content(e)
        ent = add_ko(
            ctx,
            out,
            "input",
            e,
            name=name,
            properties={
                "kind": kind,
                "index": c.get("index") or None,
                "sourcetype": c.get("sourcetype") or None,
                "host": c.get("host") or None,
                "source": c.get("source") or None,
                "interval": c.get("interval") or None,
                # batch inputs delete each file once read ("sinkhole")
                "deletesFilesAfterReading": (c.get("move_policy") == "sinkhole")
                if kind == "batch"
                else None,
                "renderXml": as_bool(c.get("renderXml", False)) if kind == "WinEventLog" else None,
                "counters": (c.get("counters") or None) if kind == "perfmon" else None,
            },
        )
        if not ent.get("disabled"):
            index = c.get("index")
            out.refs.append(
                ref(ent["id"], "index", index if index and index != "default" else "main", "feeds")
            )
            if c.get("sourcetype"):
                out.refs.append(ref(ent["id"], "sourcetype", c["sourcetype"], "feeds"))
        n += 1
    return n


# Settings every input has; the rest of a modular input's settings are its own.
_STANDARD_INPUT_KEYS = frozenset(
    {
        "index",
        "sourcetype",
        "host",
        "source",
        "interval",
        "disabled",
        "host_resolved",
        "python.version",
        "python.required",
        "run_only_one",
        "start_by_shell",
        "passAuth",
        "_rcvbuf",
    }
)


def extract_modular_inputs(ctx: Ctx, out: ExtractResult) -> int:
    """Inputs of the kinds add-ons define (modular inputs: cloud services, APIs, journald,
    ...): one per configured stanza, feeding its index and sourcetype like other inputs.
    Their own settings are listed by name only: values may be accounts, URLs or keys."""
    try:
        kinds = list(iter_entries(ctx.transport, "/services/data/modular-inputs"))
    except (EndpointNotFound, EndpointForbidden):
        return 0
    n = 0
    for kind in kinds:
        scheme = kind["name"]
        title = content(kind).get("title") or None
        try:
            entries = list(iter_entries(ctx.transport, f"{NS}/data/inputs/{scheme}"))
        except (EndpointNotFound, EndpointForbidden):
            continue
        for e in entries:
            c = content(e)
            own = sorted(
                k
                for k, v in c.items()
                if not k.startswith("eai:")
                and k not in _STANDARD_INPUT_KEYS
                and v not in (None, "")
            )
            ent = add_ko(
                ctx,
                out,
                "input",
                e,
                name=f"{scheme}://{e['name']}",
                properties={
                    "kind": scheme,
                    "modular": True,
                    "modularInputTitle": title,
                    "index": c.get("index") or None,
                    "sourcetype": c.get("sourcetype") or None,
                    "host": c.get("host") or None,
                    "source": c.get("source") or None,
                    "interval": c.get("interval") or None,
                    "settingNames": own or None,
                },
            )
            if not ent.get("disabled"):
                index = c.get("index")
                target = index if index and index != "default" else "main"
                out.refs.append(ref(ent["id"], "index", target, "feeds"))
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

    wanted = ctx.options.field_indexes
    if wanted and (bad := [p for p in wanted if not INDEX_PATTERN.match(p)]):
        raise ValueError(f"invalid index name(s) for field discovery: {', '.join(bad)}")

    def sample_indexes(e: dict[str, Any]) -> list[str]:
        """Where to sample a sourcetype: the indexes it was seen in (and that were asked for)."""
        seen = sorted(e["properties"]["observed"].get("eventsByIndex") or {})
        if wanted:
            seen = [i for i in seen if any(fnmatch.fnmatchcase(i, p) for p in wanted)]
        return seen

    sourcetypes = sorted(
        (
            e
            for e in out.entities
            if e["type"] == "sourcetype"
            and (e.get("properties", {}).get("observed") or {}).get("eventCount")
            and (not wanted or sample_indexes(e))
        ),
        key=rank,
    )[: ctx.options.max_field_sourcetypes]
    if wanted and not sourcetypes:
        return 0, f"no sourcetype was seen in the indexes asked for ({', '.join(wanted)})"
    n = 0
    failed: list[str] = []
    for st in sourcetypes:
        name = st["name"].replace('"', '\\"')
        # Only the indexes the sourcetype is in: far cheaper than all of them on a big Splunk.
        indexes = sample_indexes(st)
        where = (
            "(" + " OR ".join(f'index="{i}"' for i in indexes) + ")"
            if indexes and len(indexes) <= MAX_SAMPLE_INDEXES
            else ALL_INDEXES
        )
        try:
            rows = ctx.transport.search(
                f"fieldsummary/{st['name']}",
                f'{where} sourcetype="{name}" | head {ctx.options.field_sample_events} '
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
