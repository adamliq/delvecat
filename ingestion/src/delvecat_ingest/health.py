"""Usage attribution, health checks and the cleanup (unused objects) report.

Runs at assembly time, after merging and lineage. Writes two derived fields that
never change an entity's catalog version:

- ``entity["usage"]``: how people and the scheduler use the object (runs, views,
  ad-hoc references, last use, scheduler outcomes) and, for the cleanup report,
  ``unused`` with a ``reason``.
- ``entity["health"]``: ``{"status": "ok"|"warning"|"critical", "checks": [...]}``.

Health is judged "as of" the time the data was captured (live runs: now;
replayed fixtures: their recording time), so old recordings do not look stale.
Thresholds are the constants below.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from statistics import median
from typing import Any

from .cron import runs_per_day
from .lineage import MacroLibrary
from .model import Target
from .resolve import Resolver
from .spl import analyze

STALE_WARNING_HOURS = 24
STALE_CRITICAL_HOURS = 24 * 7
VOLUME_MIN_HISTORY_DAYS = 5
VOLUME_LOW_RATIO = 0.3
VOLUME_HIGH_RATIO = 3.0
DELAY_WARNING_SECS = 600
DELAY_CRITICAL_SECS = 3600
SKIP_WARNING_RATIO = 0.10
SKIP_CRITICAL_RATIO = 0.50
RUNTIME_WARNING_SECS = 300
FORWARDER_SILENT_HOURS = 1
HEALTH_WINDOW_DAYS = 7
SUMMARY_SOURCETYPES = ("stash", "stash_new", "stash_hec")  # summary data: delay by design

KO_TYPES = ("macro", "lookup", "eventtype", "dataModel", "kvCollection", "tag")
CONSUMER_EDGES = ("uses", "reads")
SEVERITY = {"ok": 0, "warning": 1, "critical": 2}


def _parse(ts: Any) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _later(a: str | None, b: str | None) -> str | None:
    da, db = _parse(a), _parse(b)
    if da and db:
        return a if da >= db else b
    return a or b


def _merge_usage(target: dict[str, Any], new: dict[str, Any]) -> None:
    for k, v in new.items():
        if v is None:
            continue
        if k == "lastUsed":
            target[k] = _later(target.get(k), v)
        elif isinstance(v, (int, float)) and isinstance(target.get(k), (int, float)):
            target[k] += v
        else:
            target[k] = v


# --- usage ----------------------------------------------------------------------------


def apply_usage(
    entities: list[dict[str, Any]], records: list[dict[str, Any]], adhoc: list[dict[str, Any]]
) -> None:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in entities:
        by_name[e["name"]].append(e)

    for rec in records:
        if not rec.get("name"):
            continue
        candidates = [e for e in by_name.get(rec["name"], []) if e["type"] in rec["types"]]
        if rec.get("app"):
            same_app = [e for e in candidates if e.get("app") == rec["app"]]
            candidates = same_app or [
                e for e in candidates if e.get("sharing") in ("global", "system")
            ]
        if rec.get("owner") and len(candidates) > 1:
            owned = [e for e in candidates if e.get("owner") == rec["owner"]]
            candidates = owned or candidates
        for e in candidates[:1]:
            _merge_usage(e.setdefault("usage", {}), rec["usage"])

    if not adhoc:
        return
    macros = MacroLibrary(entities)
    resolver = Resolver(entities)
    dashboards = {(e.get("app"), e["name"]): e for e in entities if e["type"] == "dashboard"}
    for row in adhoc:
        runs, last, app = row["runs"], row.get("lastUsed"), row.get("app")
        if row.get("dashboard") and (d := dashboards.get((app, row["dashboard"]))):
            _merge_usage(d.setdefault("usage", {}), {"panelSearchRuns": runs, "lastUsed": last})
        a = analyze(row["search"], macros.resolver(app, None))
        for _, target_type, name, pattern in a.refs:
            if pattern and name.strip("_") in ("*", ""):
                continue  # "index=*" says nothing about which indexes matter
            target = Target(
                target_type,
                name,
                app,
                pattern,
                visible_only=target_type
                in ("macro", "lookup", "eventtype", "savedSearch", "dataModel"),
            )
            for e in resolver.candidates(target):
                _merge_usage(e.setdefault("usage", {}), {"adhocSearches": runs, "lastUsed": last})


# --- health ---------------------------------------------------------------------------


def _check(checks: list[dict[str, str]], id_: str, status: str, message: str) -> None:
    checks.append({"check": id_, "status": status, "message": message})


def _age_hours(as_of: datetime, ts: Any) -> float | None:
    t = _parse(ts)
    return (as_of - t).total_seconds() / 3600 if t else None


def _fmt_age(hours: float) -> str:
    return f"{hours / 24:.1f} days" if hours >= 48 else f"{hours:.0f} hours"


def _data_checks(
    e: dict[str, Any], obs: dict[str, Any], as_of: datetime, checks: list[dict[str, str]]
) -> None:
    last = obs.get("lastSeen") or obs.get("latestEvent")
    age = _age_hours(as_of, last)
    total = obs.get("totalEventCount") if e["type"] == "index" else obs.get("eventCount")
    if age is not None and (total or 0) > 0:
        if age > STALE_CRITICAL_HOURS:
            _check(checks, "freshness", "critical", f"No new events for {_fmt_age(age)}")
        elif age > STALE_WARNING_HOURS:
            _check(checks, "freshness", "warning", f"No new events for {_fmt_age(age)}")
    daily = (obs.get("dailyEvents") or {}).get("counts") or []
    history = [c for c in daily[:-1] if c > 0]  # the last bucket is today, still filling
    if len(history) >= VOLUME_MIN_HISTORY_DAYS and len(daily) >= 2:
        base = median(history)
        latest = daily[-2]  # last complete day
        if base > 0 and latest < base * VOLUME_LOW_RATIO:
            _check(
                checks,
                "volume",
                "warning",
                f"Yesterday's volume ({latest:,}) is far below the usual {base:,.0f}/day",
            )
        elif base > 0 and latest > base * VOLUME_HIGH_RATIO:
            _check(
                checks,
                "volume",
                "warning",
                f"Yesterday's volume ({latest:,}) is far above the usual {base:,.0f}/day",
            )
    delay = obs.get("ingestDelaySecs")
    if isinstance(delay, (int, float)) and e["name"] not in SUMMARY_SOURCETYPES:
        if delay > DELAY_CRITICAL_SECS:
            _check(
                checks,
                "ingestDelay",
                "critical",
                f"Newest events are {delay / 60:.0f} minutes behind indexing",
            )
        elif delay > DELAY_WARNING_SECS:
            _check(
                checks,
                "ingestDelay",
                "warning",
                f"Newest events are {delay / 60:.0f} minutes behind indexing",
            )
    warnings = obs.get("parsingWarnings") or {}
    if sum(warnings.values()):
        detail = ", ".join(f"{k} {v}" for k, v in sorted(warnings.items()))
        _check(checks, "parsing", "warning", f"Parsing warnings: {detail}")


def _scheduler_checks(
    e: dict[str, Any], usage: dict[str, Any], checks: list[dict[str, str]]
) -> None:
    s = usage.get("scheduler") or {}
    total = s.get("total") or 0
    if not total:
        return
    skipped = s.get("skipped") or 0
    ratio = skipped / total
    reason = f" (last reason: {s['lastSkipReason']})" if s.get("lastSkipReason") else ""
    if ratio > SKIP_CRITICAL_RATIO:
        _check(checks, "skipped", "critical", f"Skipped {skipped} of {total} runs{reason}")
    elif ratio > SKIP_WARNING_RATIO:
        _check(checks, "skipped", "warning", f"Skipped {skipped} of {total} runs{reason}")
    if s.get("failed"):
        _check(checks, "failed", "warning", f"{s['failed']} failed runs")
    if (s.get("maxRuntimeSecs") or 0) > RUNTIME_WARNING_SECS:
        _check(
            checks, "runtime", "warning", f"Longest run took {s['maxRuntimeSecs'] / 60:.1f} minutes"
        )


def evaluate_health(
    entities: list[dict[str, Any]], as_of_iso: str | None, scheduler_since_iso: str | None = None
) -> None:
    as_of = _parse(as_of_iso) or datetime.now().astimezone()
    scheduler_since = _parse(scheduler_since_iso)
    for e in entities:
        if e.get("disabled"):
            e.pop("health", None)
            continue
        checks: list[dict[str, str]] = []
        obs = (e.get("properties") or {}).get("observed") or {}
        usage = e.get("usage") or {}
        if e["type"] in ("index", "sourcetype"):
            _data_checks(e, obs, as_of, checks)
        elif e["type"] in ("savedSearch", "correlationSearch"):
            _scheduler_checks(e, usage, checks)
            props = e.get("properties") or {}
            if props.get("isScheduled") and not usage.get("scheduler") and scheduler_since:
                rate = runs_per_day(props.get("cronSchedule"))
                covered_days = max(0.0, (as_of - scheduler_since).total_seconds() / 86400)
                expected = rate * min(covered_days, HEALTH_WINDOW_DAYS) if rate else 0
                if expected >= 2:
                    _check(
                        checks,
                        "notRunning",
                        "warning",
                        f"Scheduled to run about {expected:.0f} times since "
                        f"{scheduler_since.date()}, but the scheduler has no record of it",
                    )
        elif e["type"] in ("forwarder", "streamForwarder"):
            age = _age_hours(as_of, obs.get("lastSeen"))
            if age is not None and age > FORWARDER_SILENT_HOURS:
                _check(
                    checks,
                    "silent",
                    "warning" if age < 24 else "critical",
                    f"Last data {_fmt_age(age)} ago",
                )
        elif e["type"] == "deploymentClient":
            age = _age_hours(as_of, obs.get("lastPhoneHome"))
            interval = (obs.get("phoneHomeIntervalSecs") or 60) / 3600
            if age is not None and age > max(3 * interval, 0.25):
                _check(
                    checks,
                    "phoneHome",
                    "warning" if age < 24 else "critical",
                    f"Last phoned home {_fmt_age(age)} ago",
                )
            failed = [a for a, r in (obs.get("apps") or {}).items() if r and r != "Ok"]
            if failed:
                _check(checks, "deployment", "warning", f"Apps not installed: {', '.join(failed)}")
        if checks:
            worst = max(checks, key=lambda c: SEVERITY[c["status"]])["status"]
            e["health"] = {"status": worst, "checks": checks}
        else:
            e.pop("health", None)


# --- cleanup --------------------------------------------------------------------------


def mark_unused(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]], available: set[str]
) -> int:
    """Flag objects nothing uses. Only judges what the available usage data can show."""
    consumers: dict[str, int] = defaultdict(int)
    producers: dict[str, int] = defaultdict(int)
    for edge in edges:
        if edge["type"] in CONSUMER_EDGES:
            consumers[edge["to"]] += 1
        elif edge["type"] in ("writes", "feeds"):
            producers[edge["to"]] += 1  # an index something writes into is a destination
    # Vendor content: Splunk-authored apps and apps that belong to a Splunk product (ES, SOAR,
    # Stream, ...). Listed in the cleanup report only on request.
    builtin_apps = {
        e["name"]
        for e in entities
        if e["type"] == "app"
        and (
            "splunk" in str((e.get("properties") or {}).get("author", "")).lower()
            or (e.get("properties") or {}).get("builtin")
            or e.get("product") not in (None, "splunk")
        )
    }
    audit = "usageSavedSearches" in available or "usageAdhocSearches" in available
    views = "usageDashboardViews" in available
    n = 0
    for e in entities:
        u = e.get("usage") or {}
        reason = None
        t = e["type"]
        if e.get("disabled"):
            pass
        elif t in ("savedSearch", "correlationSearch") and audit:
            props = e.get("properties") or {}
            scheduled = props.get("isScheduled")
            ran = (u.get("runs") or 0) + ((u.get("scheduler") or {}).get("total") or 0)
            if not ran and not consumers.get(e["id"]) and not scheduled:
                reason = "Not scheduled, never run in the usage window, nothing uses it"
        elif t == "dashboard" and views:
            if not (u.get("views") or u.get("panelSearchRuns")):
                reason = "Not viewed in the usage window"
        elif t in KO_TYPES and audit:
            if not consumers.get(e["id"]) and not u.get("adhocSearches"):
                reason = "Nothing in the catalog uses it and no search referenced it"
        elif t == "index" and audit:
            obs = (e.get("properties") or {}).get("observed") or {}
            searched = consumers.get(e["id"]) or u.get("adhocSearches") or producers.get(e["id"])
            if not obs.get("totalEventCount") and not searched and not e["name"].startswith("_"):
                reason = "Empty, never searched, and nothing writes to it"
        elif t == "user" and audit and not u.get("searches"):
            reason = "No searches in the usage window"
        if reason:
            u = e.setdefault("usage", {})
            u["unused"] = True
            u["reason"] = reason
            if e.get("app") in builtin_apps or e.get("sharing") == "system":
                u["builtin"] = True
            n += 1
        elif "usage" in e:
            e["usage"].pop("unused", None)
            e["usage"].pop("reason", None)
    return n
