"""Usage and health measurements from Splunk's own logs (``_audit``, ``_internal``).

Read-only searches; DelveCat's own searches carry a marker comment and are left
out. Knowledge-object usage is recorded by name (``ExtractResult.usage``) and
matched to entities after merging; data measurements go straight onto
indexes and sourcetypes as ``observed`` values.
"""

from __future__ import annotations

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
    """Distinct ad-hoc and dashboard searches; analyzed later for the objects they use.
    The search text is only used for that analysis and is never stored in the bundle."""
    rows = ctx.transport.search(
        "usage_adhoc_searches",
        "index=_audit action=search info=completed "
        f'(savedsearch_name="" OR NOT savedsearch_name=*) '
        f"{NOT_US} | stats count as runs dc(user) as users max(_time) as last "
        f"by app, provenance, search | sort 0 - runs | head {ctx.options.max_adhoc_searches}",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        prov = r.get("provenance") or ""
        out.adhoc_searches.append(
            {
                "app": r.get("app"),
                "search": _unquote_search(r.get("search")),
                "runs": to_int(r.get("runs")) or 0,
                "lastUsed": epoch_to_iso(r.get("last")),
                "dashboard": prov.split(":", 2)[2] if prov.startswith("UI:Dashboard:") else None,
            }
        )
    return len(rows)


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


def extract_scheduler(ctx: Ctx, out: ExtractResult) -> int:
    rows = ctx.transport.search(
        "health_scheduler",
        "index=_internal sourcetype=scheduler savedsearch_name=* "
        '| stats count(eval(status="success")) as success count(eval(status="skipped")) as '
        'skipped count(eval(status="continued")) as continued count(eval(like(status, "%fail%") '
        'OR status="abandoned")) as failed count as total avg(run_time) as avgRuntime '
        "max(run_time) as maxRuntime min(_time) as first max(_time) as last "
        "latest(reason) as lastReason by app, savedsearch_name, user",
        earliest=ctx.options.health_window,
    )
    firsts = [to_int(r.get("first")) for r in rows if to_int(r.get("first"))]
    if firsts:  # how far back the scheduler log goes, so health can judge "should have run"
        out.instance_facts.setdefault("properties", {})["schedulerLogSince"] = epoch_to_iso(
            min(firsts)
        )
    for r in rows:
        out.usage.append(
            {
                "types": ["savedSearch", "correlationSearch", "scheduledView"],
                "name": r.get("savedsearch_name"),
                "app": r.get("app"),
                "owner": r.get("user"),
                "usage": {
                    "scheduler": {
                        "total": to_int(r.get("total")),
                        "success": to_int(r.get("success")),
                        "skipped": to_int(r.get("skipped")),
                        "continued": to_int(r.get("continued")),
                        "failed": to_int(r.get("failed")),
                        "avgRuntimeSecs": _float(r.get("avgRuntime")),
                        "maxRuntimeSecs": _float(r.get("maxRuntime")),
                        "lastRun": epoch_to_iso(r.get("last")),
                        "lastSkipReason": r.get("lastReason") or None,
                        "window": ctx.options.health_window,
                    }
                },
            }
        )
    return len(rows)


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
        "| stats sum(sched) as schedFired sum(supp) as suppressed sum(audit) as auditFired "
        "max(firedAt) as last by ssApp, name "
        "| where schedFired>0 OR suppressed>0 OR auditFired>0",
        earliest=ctx.options.usage_window,
    )
    for r in rows:
        if not r.get("name"):
            continue
        fires = max(to_int(r.get("schedFired")) or 0, to_int(r.get("auditFired")) or 0)
        out.usage.append(
            {
                "types": ["savedSearch", "correlationSearch"],
                "name": r["name"],
                "app": r.get("ssApp"),
                "usage": {
                    "alertFires": fires,
                    "alertsSuppressed": to_int(r.get("suppressed")) or 0,
                    "lastFired": epoch_to_iso(r.get("last")),
                    "alertWindow": ctx.options.usage_window,
                },
            }
        )
    # Alerts with no record fired zero times in this window (set after matching).
    out.instance_facts.setdefault("properties", {})["alertUsageWindow"] = ctx.options.usage_window
    return len(rows)


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
