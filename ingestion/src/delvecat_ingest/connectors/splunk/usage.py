"""Usage and health measurements from Splunk's own logs (``_audit``, ``_internal``).

Read-only searches; Licoryx Delvecat's own searches carry a marker comment and are left
out. Knowledge-object usage is recorded by name (``ExtractResult.usage``) and
matched to entities after merging; data measurements go straight onto
indexes and sourcetypes as ``observed`` values.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from ...compat import UTC
from ...model import ExtractResult
from ...transport import SEARCH_MARKER
from .common import Ctx, add_global, epoch_to_iso, to_int

NOT_US = f'NOT search="*{SEARCH_MARKER.strip("`")}*"'
ALL = "(index=* OR index=_*)"


def _unquote_search(s: str) -> str:
    s = (s or "").strip()
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] == "'" else s


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def extract_saved_search_runs(ctx: Ctx, out: ExtractResult) -> int:
    """Runs of saved searches (scheduled, dashboards, ad hoc) from the audit log."""
    rows = ctx.transport.search(
        "usage_saved_searches",
        f'index=_audit action=search info=completed savedsearch_name=* savedsearch_name!="" '
        f"{NOT_US} | stats count as runs dc(user) as users max(_time) as last "
        "sum(total_run_time) as runtime by app, savedsearch_name",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        out.usage.append(
            {
                "types": ["savedSearch", "correlationSearch", "scheduledView"],
                "name": r.get("savedsearch_name"),
                "app": r.get("app"),
                "usage": {
                    "runs": to_int(r.get("runs")),
                    "users": to_int(r.get("users")),
                    "lastUsed": epoch_to_iso(r.get("last")),
                    "runtimeSecs": _float(r.get("runtime")),
                },
            }
        )
    return len(rows)


def extract_adhoc_searches(ctx: Ctx, out: ExtractResult) -> int:
    """Distinct ad-hoc and dashboard searches: analyzed for the objects they use, and the
    most-run ad-hoc ones (not dashboard panels) become catalog objects of their own."""
    rows = ctx.transport.search(
        "usage_adhoc_searches",
        "index=_audit action=search info=completed "
        f'(savedsearch_name="" OR NOT savedsearch_name=*) '
        f"{NOT_US} | stats count as runs dc(user) as users max(_time) as last "
        f"by app, provenance, search | sort 0 - runs | head {ctx.options.max_adhoc_searches}",
        earliest=ctx.options.usage_window,
    )
    objects: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        prov = r.get("provenance") or ""
        row = {
            "app": r.get("app"),
            "search": _unquote_search(r.get("search")),
            "runs": to_int(r.get("runs")) or 0,
            "lastUsed": epoch_to_iso(r.get("last")),
            "dashboard": prov.split(":", 2)[2] if prov.startswith("UI:Dashboard:") else None,
        }
        out.adhoc_searches.append(row)
        if row["dashboard"] or not _is_adhoc_object(row["search"], prov):
            continue  # dashboard panels are part of their dashboards
        if not ctx.options.adhoc_splunk_apps and (row["app"] or "") in SPLUNK_APPS:
            continue
        key = (row["app"] or "search", row["search"])
        o = objects.setdefault(key, {"runs": 0, "users": 0, "lastUsed": None, "from": set()})
        o["runs"] += row["runs"]
        o["users"] = max(o["users"], to_int(r.get("users")) or 0)  # people may overlap
        o["lastUsed"] = max(filter(None, (o["lastUsed"], row["lastUsed"])), default=None)
        o["from"].add(_provenance_label(prov))
    top = sorted(objects.items(), key=lambda kv: -kv[1]["runs"])[: ctx.options.adhoc_objects]
    for (app, spl), o in top:
        add_global(
            ctx,
            out,
            "adhocSearch",
            adhoc_name(app, spl),
            app=app,
            displayName=adhoc_title(spl),
            properties={
                "search": spl[:ADHOC_MAX_CHARS],
                "truncated": len(spl) > ADHOC_MAX_CHARS or None,
                "runFrom": sorted(o["from"]),
                "usageWindow": ctx.options.usage_window,
            },
            usage={"runs": o["runs"], "users": o["users"], "lastUsed": o["lastUsed"]},
        )
    return len(rows)


ADHOC_MAX_CHARS = 10000


def adhoc_name(app: str, spl: str) -> str:
    """A stable name for an ad-hoc search: the same text in the same app, the same object."""
    digest = hashlib.sha1(f"{app}\0{' '.join(spl.split())}".encode()).hexdigest()
    return f"adhoc-{digest[:12]}"


def adhoc_title(spl: str, width: int = 90) -> str:
    one = " ".join(spl.split())
    return one if len(one) <= width else one[: width - 1].rstrip() + "…"


def _provenance_label(prov: str) -> str:
    """Where a search was run from, as _audit records it (UI:Search, rest, ...)."""
    if prov.startswith("UI:"):
        return prov.split(":", 2)[1] or "UI"
    return "REST API" if prov in ("", "N/A") or prov.startswith("rest") else prov


# Apps that ship with Splunk and search on their own (health checks, telemetry, consoles).
SPLUNK_APPS = frozenset(
    {
        "splunk_monitoring_console",
        "splunk_instrumentation",
        "SplunkDeploymentServerConfig",
        "splunk_secure_gateway",
        "splunk_rapid_diag",
        "splunk_assist",
        "python_upgrade_readiness_app",
        "splunk_internal_metrics",
        "splunk_metrics_workspace",
        "splunk-dashboard-studio",
        "dmc",
        "launcher",
    }
)

# Searches Splunk runs for itself, and this app's own build command.
_SYSTEM_SEARCH = re.compile(r"^\s*\|?\s*(summarize|delvecatbuild)\b", re.IGNORECASE)


def _is_adhoc_object(spl: str, prov: str) -> bool:
    return bool(spl.strip()) and prov != "summary_director" and not _SYSTEM_SEARCH.match(spl)


def extract_user_activity(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "usage_users",
        f"index=_audit action=search info=completed {NOT_US} "
        "| stats count as searches max(_time) as last by user",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        out.usage.append(
            {
                "types": ["user"],
                "name": r.get("user"),
                "usage": {
                    "searches": to_int(r.get("searches")),
                    "lastUsed": epoch_to_iso(r.get("last")),
                },
            }
        )
    return len(rows)


def extract_dashboard_views(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "usage_dashboard_views",
        'index=_internal sourcetype=splunk_web_access uri_path="*/app/*/*" status<400 '
        '| rex field=uri_path "/app/(?<app>[^/]+)/(?<view>[^/?]+)" '
        "| stats count as views dc(user) as users max(_time) as last by app, view",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        out.usage.append(
            {
                "types": ["dashboard"],
                "name": r.get("view"),
                "app": r.get("app"),
                "usage": {
                    "views": to_int(r.get("views")),
                    "viewers": to_int(r.get("users")),
                    "lastUsed": epoch_to_iso(r.get("last")),
                },
            }
        )
    return len(rows)


def _day(t: Any) -> str | None:
    """A search result's ``_time`` (epoch or ISO) as a date."""
    if not t:
        return None
    if str(t).replace(".", "").isdigit():
        return (epoch_to_iso(t) or "")[:10] or None
    return str(t)[:10]


def _daily(by_day: dict[str, int], days: list[str]) -> dict[str, Any]:
    return {"start": days[0], "counts": [by_day.get(d, 0) for d in days]}


def _days_between(days: set[str]) -> list[str]:
    """Every date from the first to the last seen (so a quiet day is a 0, not a gap)."""
    if not days:
        return []
    first, last = (datetime.fromisoformat(d) for d in (min(days), max(days)))
    return [(first + timedelta(days=i)).date().isoformat() for i in range((last - first).days + 1)]


def extract_scheduler(ctx: Ctx, out: ExtractResult) -> int:
    # Per day as well, so the health page can show when runs were skipped or failed.
    rows = ctx.transport.search(
        "health_scheduler",
        "index=_internal sourcetype=scheduler savedsearch_name=* | bin _time span=1d "
        '| stats count(eval(status="success")) as success count(eval(status="skipped")) as '
        'skipped count(eval(status="continued")) as continued count(eval(like(status, "%fail%") '
        'OR status="abandoned")) as failed count as total avg(run_time) as avgRuntime '
        "max(run_time) as maxRuntime min(_time) as first max(_time) as last "
        "latest(reason) as lastReason by app, savedsearch_name, user, _time",
        earliest=ctx.options.health_window,
    )
    firsts = [to_int(r.get("first")) for r in rows if to_int(r.get("first"))]
    if firsts:  # how far back the scheduler log goes, so health can judge "should have run"
        out.instance_facts.setdefault("properties", {})["schedulerLogSince"] = epoch_to_iso(
            min(firsts)
        )
    COUNTS = ("total", "success", "skipped", "continued", "failed")
    merged: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    all_days: set[str] = set()
    for r in rows:
        key = (r.get("app"), r.get("savedsearch_name"), r.get("user"))
        m = merged.setdefault(
            key, {**{k: 0 for k in COUNTS}, "runtime": 0.0, "max": None, "last": None, "days": {}}
        )
        total = to_int(r.get("total")) or 0
        for k in COUNTS:
            m[k] += to_int(r.get(k)) or 0
        m["runtime"] += (_float(r.get("avgRuntime")) or 0) * total
        mx = _float(r.get("maxRuntime"))
        if mx is not None and (m["max"] is None or mx > m["max"]):
            m["max"] = mx
        last = _float(r.get("last"))
        if last is not None and (m["last"] is None or last > m["last"]):
            m["last"] = last
            m["reason"] = r.get("lastReason") or m.get("reason")
        elif not m.get("reason"):
            m["reason"] = r.get("lastReason")
        if day := _day(r.get("_time")):
            all_days.add(day)
            bad = (to_int(r.get("skipped")) or 0) + (to_int(r.get("failed")) or 0)
            m["days"][day] = (
                m["days"].get(day, (0, 0))[0] + total,
                m["days"].get(day, (0, 0))[1] + bad,
            )
    days = _days_between(all_days)
    for (app, name, user), m in merged.items():
        scheduler: dict[str, Any] = {
            "total": m["total"],
            "success": m["success"],
            "skipped": m["skipped"],
            "continued": m["continued"],
            "failed": m["failed"],
            "avgRuntimeSecs": round(m["runtime"] / m["total"], 3) if m["total"] else None,
            "maxRuntimeSecs": m["max"],
            "lastRun": epoch_to_iso(m["last"]),
            "lastSkipReason": m.get("reason") or None,
            "window": ctx.options.health_window,
        }
        if days and m["days"]:
            # Runs and runs that were skipped or failed, per day.
            scheduler["daily"] = {
                "start": days[0],
                "runs": [m["days"].get(d, (0, 0))[0] for d in days],
                "problems": [m["days"].get(d, (0, 0))[1] for d in days],
            }
        out.usage.append(
            {
                "types": ["savedSearch", "correlationSearch", "scheduledView"],
                "name": name,
                "app": app,
                "owner": user,
                "usage": {"scheduler": scheduler},
            }
        )
    return len(merged)


def extract_license(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "health_license",
        "index=_internal source=*license_usage.log* type=Usage "
        "| stats sum(b) as bytes min(_time) as first max(_time) as last by idx, st",
        earliest=ctx.options.usage_window,
    )
    per_index: dict[str, float] = defaultdict(float)
    per_st: dict[str, float] = defaultdict(float)
    days = 1.0
    for r in rows:
        b = _float(r.get("bytes")) or 0
        per_index[r.get("idx") or "?"] += b
        per_st[r.get("st") or "?"] += b
        span = ((_float(r.get("last")) or 0) - (_float(r.get("first")) or 0)) / 86400
        days = max(days, span)
    for idx, b in per_index.items():
        add_global(ctx, out, "index", idx, observed={"licenseMBPerDay": round(b / days / 2**20, 3)})
    for st, b in per_st.items():
        add_global(
            ctx, out, "sourcetype", st, observed={"licenseMBPerDay": round(b / days / 2**20, 3)}
        )
    return len(rows)


def extract_daily_volume(ctx: Ctx, out: ExtractResult) -> int:
    days = ctx.options.volume_days
    rows = ctx.transport.search(
        "health_daily_volume",
        f"| tstats count where {ALL} by _time span=1d, index, sourcetype",
        earliest=f"-{days}d@d",
    )
    series: dict[tuple[str, str], dict[str, int]] = defaultdict(dict)
    all_days: set[str] = set()
    for r in rows:
        t = r.get("_time")
        day = (
            str(t)[:10]
            if t and not str(t).replace(".", "").isdigit()
            else (epoch_to_iso(t) or "")[:10]
        )
        if not day:
            continue
        all_days.add(day)
        c = to_int(r.get("count")) or 0
        for key in (("index", r.get("index")), ("sourcetype", r.get("sourcetype"))):
            if key[1]:
                series[key][day] = series[key].get(day, 0) + c
    if not all_days:
        return 0
    end = max(datetime.fromisoformat(d) for d in all_days)
    window = [(end - timedelta(days=i)).date().isoformat() for i in range(days - 1, -1, -1)]
    for (type_, name), by_day in series.items():
        add_global(
            ctx,
            out,
            type_,
            name,
            observed={
                "dailyEvents": {"start": window[0], "counts": [by_day.get(d, 0) for d in window]}
            },
        )
    return len(series)


def extract_ingest_delay(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "health_ingest_delay",
        "| tstats max(_indextime) as indexed max(_time) as newest "
        f"where {ALL} by index, sourcetype",
        earliest="-24h",
    )
    for r in rows:
        indexed, newest = _float(r.get("indexed")), _float(r.get("newest"))
        if indexed is None or newest is None:
            continue
        # How far behind the newest indexed event's timestamp is the newest indexing time.
        delay = max(0, round(indexed - newest))
        add_global(
            ctx, out, "sourcetype", r.get("sourcetype") or "?", observed={"ingestDelaySecs": delay}
        )
    return len(rows)


def extract_parsing_warnings(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "health_parsing",
        "index=_internal sourcetype=splunkd log_level=WARN (component=DateParserVerbose OR "
        "component=LineBreakingProcessor OR component=AggregatorMiningProcessor) "
        "data_sourcetype=* | stats count by component, data_sourcetype",
        earliest=ctx.options.health_window,
    )
    per_st: dict[str, dict[str, int]] = defaultdict(dict)
    for r in rows:
        per_st[r["data_sourcetype"]][r.get("component") or "?"] = to_int(r.get("count")) or 0
    for st, counts in per_st.items():
        add_global(ctx, out, "sourcetype", st, observed={"parsingWarnings": counts})
    return len(per_st)


def extract_hec_usage(ctx: Ctx, out: ExtractResult) -> int:
    """HTTP Event Collector use per token: events, bytes and errors from HEC's metrics
    (_introspection), and why requests were rejected (_internal).

    The metrics record a token only in minutes it was used. Requests with an invalid
    token are counted for the instance; the token they tried is never read into the
    catalog (it may be someone's real token)."""
    rows = ctx.transport.search(
        "usage_hec",
        "index=_introspection sourcetype=http_event_collector_metrics "
        "data.series=http_event_collector_token "
        "| rename data.token_name as token "
        "| eval used=if('data.num_of_events'>0, _time, null()) "
        "| stats sum(data.num_of_events) as events sum(data.total_bytes_received) as bytes "
        "sum(data.num_of_requests) as requests sum(data.num_of_errors) as errors "
        "sum(data.num_of_parser_errors) as parserErrors "
        "sum(data.num_of_requests_to_disabled_token) as toDisabled "
        "max(used) as last by token",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        if not r.get("token"):
            continue
        out.usage.append(
            {
                "types": ["input"],
                "name": f"http://{r['token']}",
                "usage": {
                    "hecEvents": to_int(r.get("events")) or 0,
                    "hecBytes": to_int(r.get("bytes")) or 0,
                    "hecRequests": to_int(r.get("requests")) or 0,
                    "hecErrors": (to_int(r.get("errors")) or 0)
                    + (to_int(r.get("parserErrors")) or 0),
                    "hecRequestsToDisabled": to_int(r.get("toDisabled")) or 0,
                    "lastUsed": epoch_to_iso(r.get("last")),
                    "hecWindow": ctx.options.usage_window,
                },
            }
        )
    # Why requests were rejected, per token (HttpInputDataHandler logs each one).
    rejected = ctx.transport.search(
        "usage_hec_rejections",
        "index=_internal sourcetype=splunkd component=HttpInputDataHandler log_level=ERROR "
        '| rex "token name=(?<token>[^,]+)" '
        '| rex "status_message=\\"(?<reason>[^\\"]+)\\"" '
        "| rex \"invalid_index='(?<badIndex>[^']+)'\" "
        '| fillnull value="" badIndex '  # stats drops events missing a "by" field
        "| stats count max(_time) as last by token, reason, badIndex",
        earliest=ctx.options.health_window,
    )
    by_token: dict[str, list[dict[str, Any]]] = defaultdict(list)
    invalid_token = 0
    for r in rejected:
        token, count = r.get("token"), to_int(r.get("count")) or 0
        if not token or token == "unknown":  # an invalid token: count it, keep nothing else
            invalid_token += count
            continue
        by_token[token].append(
            {
                "reason": r.get("reason") or "rejected",
                "index": r.get("badIndex") or None,
                "count": count,
                "last": epoch_to_iso(r.get("last")),
            }
        )
    for token, reasons in by_token.items():
        reasons.sort(key=lambda x: -x["count"])
        out.usage.append(
            {
                "types": ["input"],
                "name": f"http://{token}",
                "usage": {
                    "hecRejections": reasons[:10],
                    "hecRejectionWindow": ctx.options.health_window,
                },
            }
        )
    hec = out.instance_facts.setdefault("properties", {}).setdefault("httpEventCollector", {})
    hec["invalidTokenRequests"] = invalid_token
    hec["usageWindow"] = ctx.options.usage_window
    return len(rows)


def extract_alert_fires(ctx: Ctx, out: ExtractResult) -> int:
    """How often each alert actually fired, as opposed to ran.

    Two records of a firing: the scheduler log (every run, with the actions it
    triggered and whether throttling suppressed it) and ``_audit`` ``alert_fired``
    (tracked alerts only, including ones with no actions). Per alert the larger count
    is used, so a firing recorded in both is counted once."""
    rows = ctx.transport.search(
        "usage_alert_fires",
        "(index=_internal sourcetype=scheduler savedsearch_name=* status=success) "
        "OR (index=_audit action=alert_fired) "
        "| eval name=coalesce(ss_name, savedsearch_name), ssApp=coalesce(ss_app, app) "
        '| eval sched=if(sourcetype=="scheduler" AND alert_actions!="" AND suppressed!="1", 1, 0), '
        'supp=if(sourcetype=="scheduler" AND suppressed=="1", 1, 0), '
        'audit=if(action=="alert_fired", 1, 0), '
        "firedAt=if(sched==1 OR audit==1, _time, null()) "
        "| bin _time span=1d "
        "| stats sum(sched) as schedFired sum(supp) as suppressed sum(audit) as auditFired "
        "max(firedAt) as last by ssApp, name, _time "
        "| where schedFired>0 OR suppressed>0 OR auditFired>0",
        earliest=ctx.options.usage_window,
    )
    # One row per alert and day (older recordings: per alert); summed here.
    alerts: dict[tuple[str, Any], dict[str, Any]] = {}
    all_days: set[str] = set()
    for r in rows:
        if not r.get("name"):
            continue
        a = alerts.setdefault(
            (r["name"], r.get("ssApp")), {"fires": 0, "suppressed": 0, "last": None, "days": {}}
        )
        fires = max(to_int(r.get("schedFired")) or 0, to_int(r.get("auditFired")) or 0)
        a["fires"] += fires
        a["suppressed"] += to_int(r.get("suppressed")) or 0
        last = _float(r.get("last"))
        if last is not None and (a["last"] is None or last > a["last"]):
            a["last"] = last
        if day := _day(r.get("_time")):
            all_days.add(day)
            a["days"][day] = a["days"].get(day, 0) + fires
    days = _days_between(all_days)
    for (name, app), a in alerts.items():
        usage: dict[str, Any] = {
            "alertFires": a["fires"],
            "alertsSuppressed": a["suppressed"],
            "lastFired": epoch_to_iso(a["last"]),
            "alertWindow": ctx.options.usage_window,
        }
        if days and a["days"]:
            usage["alertDaily"] = _daily(a["days"], days)
        out.usage.append(
            {
                "types": ["savedSearch", "correlationSearch"],
                "name": name,
                "app": app,
                "usage": usage,
            }
        )
    # Alerts with no record fired zero times in this window (set after matching).
    out.instance_facts.setdefault("properties", {})["alertUsageWindow"] = ctx.options.usage_window
    return len(alerts)


USAGE_EXTRACTORS = {
    "usageSavedSearches": extract_saved_search_runs,
    "usageAdhocSearches": extract_adhoc_searches,
    "usageUsers": extract_user_activity,
    "usageDashboardViews": extract_dashboard_views,
    "healthScheduler": extract_scheduler,
    "healthLicense": extract_license,
    "healthDailyVolume": extract_daily_volume,
    "healthIngestDelay": extract_ingest_delay,
    "healthParsing": extract_parsing_warnings,
    "usageHec": extract_hec_usage,
    "usageAlerts": extract_alert_fires,
}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
