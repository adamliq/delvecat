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
from .lineage import KNOWLEDGE_TYPES, MacroLibrary, add_command_refs, command_names
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
TOKEN_EXPIRY_WARNING_DAYS = 14  # a token expiring this soon breaks whatever uses it
TOKEN_STALE_DAYS = 90  # not used for this long: probably not needed
ALERT_NOISY_PER_DAY = 24  # an alert firing more than hourly on average is hard to act on
SUMMARY_SOURCETYPES = ("stash", "stash_new", "stash_hec")  # summary data: delay by design

KO_TYPES = (
    "macro",
    "lookup",
    "eventtype",
    "dataModel",
    "kvCollection",
    "tag",
    "searchCommand",
)
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
        if k in ("lastUsed", "lastFired"):
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
    commands = command_names(entities)
    resolver = Resolver(entities)
    dashboards = {(e.get("app"), e["name"]): e for e in entities if e["type"] == "dashboard"}
    for row in adhoc:
        runs, last, app = row["runs"], row.get("lastUsed"), row.get("app")
        if row.get("dashboard") and (d := dashboards.get((app, row["dashboard"]))):
            _merge_usage(d.setdefault("usage", {}), {"panelSearchRuns": runs, "lastUsed": last})
        a = analyze(row["search"], macros.resolver(app, None))
        add_command_refs(a, commands)
        for _, target_type, name, pattern in a.refs:
            if pattern and name.strip("_") in ("*", ""):
                continue  # "index=*" says nothing about which indexes matter
            target = Target(
                target_type,
                name,
                app,
                pattern,
                visible_only=target_type in KNOWLEDGE_TYPES,
            )
            for e in resolver.candidates(target):
                _merge_usage(e.setdefault("usage", {}), {"adhocSearches": runs, "lastUsed": last})


def is_alert(e: dict[str, Any]) -> bool:
    """A scheduled alert with a trigger condition, or a detection (not a report that
    acts on every run)."""
    p = e.get("properties") or {}
    if e.get("disabled") or not p.get("isScheduled", True):
        return False
    # A detection always alerts: its notables are its firings.
    return e["type"] == "correlationSearch" or (
        e["type"] == "savedSearch" and p.get("kind") == "alert"
    )


def fill_alert_fires(entities: list[dict[str, Any]], window: str | None) -> int:
    """After the fired-alerts part ran: alerts with no record fired zero times."""
    n = 0
    for e in entities:
        if is_alert(e) and "alertFires" not in (e.get("usage") or {}):
            u = e.setdefault("usage", {})
            u["alertFires"] = 0
            u["alertsSuppressed"] = 0
            if window:
                u["alertWindow"] = window
            n += 1
    return n


def _days(window: str | None) -> float | None:
    import re

    m = re.fullmatch(r"-(\d+)(d|h)", window or "")
    if not m:
        return None
    return int(m.group(1)) / (24 if m.group(2) == "h" else 1)


def _alert_checks(e: dict[str, Any], u: dict[str, Any], checks: list[dict[str, str]]) -> None:
    fires, days = u.get("alertFires"), _days(u.get("alertWindow"))
    if not fires or not days or not is_alert(e):
        return
    per_day = fires / days
    if per_day > ALERT_NOISY_PER_DAY:
        _check(
            checks,
            "alertNoisy",
            "warning",
            f"Fired {fires:,} times in {_window(u['alertWindow'])} (about {per_day:,.0f} a day): "
            "too often for each one to be acted on",
        )


# --- health ---------------------------------------------------------------------------


def _check(checks: list[dict[str, str]], id_: str, status: str, message: str) -> None:
    checks.append({"check": id_, "status": status, "message": message})


def _age_hours(as_of: datetime, ts: Any) -> float | None:
    t = _parse(ts)
    return (as_of - t).total_seconds() / 3600 if t else None


def _fmt_age(hours: float) -> str:
    if hours >= 48:
        return f"{hours / 24:.1f} days"
    n = round(hours)
    return f"{n} hour{'' if n == 1 else 's'}"


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


def _window(spl: str | None) -> str:
    """Splunk's relative time ("-7d") in words ("the last 7 days")."""
    import re

    m = re.fullmatch(r"-(\d+)(d|h|m)", spl or "")
    if not m:
        return spl or ""
    n, unit = int(m.group(1)), {"d": "day", "h": "hour", "m": "minute"}[m.group(2)]
    return f"the last {n} {unit}{'s' if n != 1 else ''}"


def _hec_checks(e: dict[str, Any], u: dict[str, Any], checks: list[dict[str, str]]) -> None:
    """An HTTP Event Collector token: HEC switched off, rejected requests, requests sent
    to it while disabled (disabled tokens are not evaluated otherwise)."""
    if (e.get("properties") or {}).get("hecEnabled") is False:
        _check(
            checks,
            "hecOff",
            "critical",
            "HTTP Event Collector is turned off on this instance: the token receives nothing",
        )
    rejected = u.get("hecRejections") or []
    if rejected:
        total = sum(r.get("count") or 0 for r in rejected)
        why = "; ".join(
            f"{r['reason']}" + (f" ({r['index']})" if r.get("index") else "") + f" ×{r['count']}"
            for r in rejected[:3]
        )
        window = u.get("hecRejectionWindow")
        _check(
            checks,
            "hecRejected",
            "warning",
            f"{total:,} requests rejected{f' in {_window(window)}' if window else ''}: {why}",
        )
    elif u.get("hecErrors"):
        _check(checks, "hecErrors", "warning", f"{u['hecErrors']:,} requests failed")


def _token_checks(
    e: dict[str, Any], as_of: datetime, users: set[tuple[str, str]] | None, checks: list
) -> None:
    """An authentication token: expired or about to, never expiring, unused for a long
    time, or belonging to a user Splunk no longer has."""
    p = e.get("properties") or {}
    expires = _parse(p.get("expiresAt"))
    if expires is not None:
        days_left = (expires - as_of).total_seconds() / 86400
        if days_left <= 0:
            _check(
                checks,
                "tokenExpired",
                "warning",
                f"Expired {_fmt_age(-days_left * 24)} ago: it no longer works; delete it",
            )
        elif days_left <= TOKEN_EXPIRY_WARNING_DAYS:
            _check(
                checks,
                "tokenExpiring",
                "warning",
                f"Expires in {_fmt_age(days_left * 24)}: whatever uses it stops working then",
            )
    elif p.get("neverExpires"):
        _check(checks, "tokenNoExpiry", "warning", "Never expires")
    if expires is None or expires > as_of:
        last = _age_hours(as_of, p.get("lastUsed"))
        issued = _age_hours(as_of, p.get("issuedAt"))
        if last is not None and last > TOKEN_STALE_DAYS * 24:
            _check(checks, "tokenStale", "warning", f"Not used for {_fmt_age(last)}")
        elif last is None and issued is not None and issued > TOKEN_STALE_DAYS * 24:
            _check(
                checks,
                "tokenStale",
                "warning",
                f"Never used since it was issued {_fmt_age(issued)} ago",
            )
    user = p.get("user")
    if users is not None and (not user or (e.get("instance"), user) not in users):
        _check(
            checks,
            "tokenNoOwner",
            "critical",
            "Its user no longer exists in Splunk" if user else "No user",
        )


def evaluate_health(
    entities: list[dict[str, Any]], as_of_iso: str | None, scheduler_since_iso: str | None = None
) -> None:
    as_of = _parse(as_of_iso) or datetime.now().astimezone()
    scheduler_since = _parse(scheduler_since_iso)
    # Users per instance, for tokens; None where users were not collected.
    user_names = {(e.get("instance"), e["name"]) for e in entities if e["type"] == "user"}
    with_users = {i for i, _ in user_names}
    for e in entities:
        if e.get("disabled"):
            e.pop("health", None)
            sent = (e.get("usage") or {}).get("hecRequestsToDisabled")
            if sent:  # a disabled HEC token someone still sends to: their data is lost
                msg = f"{sent:,} requests sent to this disabled token were refused"
                e["health"] = {
                    "status": "warning",
                    "checks": [{"check": "hecDisabledInUse", "status": "warning", "message": msg}],
                }
            continue
        checks: list[dict[str, str]] = []
        obs = (e.get("properties") or {}).get("observed") or {}
        usage = e.get("usage") or {}
        if e["type"] in ("index", "sourcetype"):
            _data_checks(e, obs, as_of, checks)
        elif e["type"] in ("savedSearch", "correlationSearch"):
            _scheduler_checks(e, usage, checks)
            _alert_checks(e, usage, checks)
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
        elif e["type"] == "input" and (e.get("properties") or {}).get("kind") == "http":
            _hec_checks(e, usage, checks)
        elif e["type"] == "authToken":
            _token_checks(e, as_of, user_names if e.get("instance") in with_users else None, checks)
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
        elif t == "authToken" and (
            stale := [
                c
                for c in (e.get("health") or {}).get("checks", [])
                if c["check"] in ("tokenExpired", "tokenStale", "tokenNoOwner")
            ]
        ):
            reason = f"Authentication token: {stale[0]['message']}"
        elif t == "user" and audit and not u.get("searches"):
            reason = "No searches in the usage window"
        elif (
            t == "input"
            and "usageHec" in available
            and (e.get("properties") or {}).get("kind") == "http"
            and not u.get("hecEvents")
        ):
            reason = "HTTP Event Collector token: no events received in the usage window"
        if reason:
            u = e.setdefault("usage", {})
            u["unused"] = True
            u["reason"] = reason
            # HEC tokens live in Splunk's own apps (search, splunk_httpinput) but are made by
            # people, so an idle one is never "built-in" (hidden from cleanup by default).
            hec_token = t == "input" and (e.get("properties") or {}).get("kind") == "http"
            if not hec_token and (e.get("app") in builtin_apps or e.get("sharing") == "system"):
                u["builtin"] = True
            n += 1
        elif "usage" in e:
            e["usage"].pop("unused", None)
            e["usage"].pop("reason", None)
    return n
