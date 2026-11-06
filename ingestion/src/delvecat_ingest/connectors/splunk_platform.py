"""Splunk platform connector (Enterprise and Cloud) — Phase 0 subset.

Extracts apps, indexes, saved searches, dashboards and macros. Further
knowledge-object types are added in Phase 1.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from ..model import ExtractResult, entity, fqn
from ..splunk_rest import as_bool, iter_entries
from ..transport import EndpointNotFound, Transport

NS = "/servicesNS/-/-"


def _acl(entry: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    acl = entry.get("acl") or {}
    return acl.get("app"), acl.get("owner"), acl.get("sharing")


def _app_edge(instance: str, app: str | None, child_id: str) -> dict[str, Any] | None:
    if not app:
        return None
    return {
        "from": fqn(instance, "app", app),
        "to": child_id,
        "type": "contains",
        "origin": "config",
    }


def _ko(
    instance: str,
    type_: str,
    entry: dict[str, Any],
    *,
    description: str | None = None,
    properties: dict[str, Any],
    display_name: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Build an app-scoped knowledge object and its app→object edge."""
    app, owner, sharing = _acl(entry)
    content = entry.get("content") or {}
    eid = fqn(instance, type_, entry["name"], app=app or "unknown", owner=owner)
    ent = entity(
        id=eid,
        type=type_,
        name=entry["name"],
        displayName=display_name,
        instance=instance,
        app=app,
        owner=owner,
        sharing=sharing,
        disabled=as_bool(content.get("disabled", False)),
        description=description,
        updatedAt=entry.get("updated"),
        properties=properties,
    )
    return ent, _app_edge(instance, app, eid)


def extract_apps(t: Transport, instance: str) -> Iterable[tuple[dict, dict | None]]:
    for e in iter_entries(t, "/services/apps/local"):
        c = e.get("content") or {}
        yield (
            entity(
                id=fqn(instance, "app", e["name"]),
                type="app",
                name=e["name"],
                displayName=c.get("label"),
                instance=instance,
                disabled=as_bool(c.get("disabled", False)),
                description=c.get("description"),
                updatedAt=e.get("updated"),
                properties={
                    "version": c.get("version"),
                    "author": c.get("author"),
                    "visible": as_bool(c.get("visible", True)),
                },
            ),
            None,
        )


def extract_indexes(t: Transport, instance: str) -> Iterable[tuple[dict, dict | None]]:
    for e in iter_entries(t, "/services/data/indexes"):
        c = e.get("content") or {}
        app, _, _ = _acl(e)
        eid = fqn(instance, "index", e["name"])
        yield (
            entity(
                id=eid,
                type="index",
                name=e["name"],
                instance=instance,
                app=app,
                disabled=as_bool(c.get("disabled", False)),
                updatedAt=e.get("updated"),
                properties={
                    "datatype": c.get("datatype", "event"),
                    "currentDBSizeMB": c.get("currentDBSizeMB"),
                    "maxTotalDataSizeMB": c.get("maxTotalDataSizeMB"),
                    "totalEventCount": c.get("totalEventCount"),
                    "frozenTimePeriodInSecs": c.get("frozenTimePeriodInSecs"),
                    "minTime": c.get("minTime"),
                    "maxTime": c.get("maxTime"),
                },
            ),
            _app_edge(instance, app, eid),
        )


def _saved_search_kind(c: dict[str, Any]) -> str:
    if not as_bool(c.get("is_scheduled", False)):
        return "report"
    if c.get("alert_type", "always") != "always":
        return "alert"
    return "scheduledReport"


def extract_saved_searches(t: Transport, instance: str) -> Iterable[tuple[dict, dict | None]]:
    for e in iter_entries(t, f"{NS}/saved/searches"):
        c = e.get("content") or {}
        actions = [a.strip() for a in str(c.get("actions") or "").split(",") if a.strip()]
        yield _ko(
            instance,
            "savedSearch",
            e,
            description=c.get("description"),
            properties={
                "kind": _saved_search_kind(c),
                "search": c.get("search"),
                "isScheduled": as_bool(c.get("is_scheduled", False)),
                "cronSchedule": c.get("cron_schedule") or None,
                "earliestTime": c.get("dispatch.earliest_time") or None,
                "latestTime": c.get("dispatch.latest_time") or None,
                "alertType": c.get("alert_type"),
                "actions": actions,
            },
        )


def extract_dashboards(t: Transport, instance: str) -> Iterable[tuple[dict, dict | None]]:
    for e in iter_entries(t, f"{NS}/data/ui/views"):
        c = e.get("content") or {}
        source = str(c.get("eai:data") or "")
        framework = "dashboardStudio" if 'version="2"' in source else "simpleXml"
        yield _ko(
            instance,
            "dashboard",
            e,
            display_name=c.get("label"),
            description=c.get("description"),
            properties={"framework": framework, "sourceBytes": len(source.encode())},
        )


def extract_macros(t: Transport, instance: str) -> Iterable[tuple[dict, dict | None]]:
    for e in iter_entries(t, f"{NS}/admin/macros"):
        c = e.get("content") or {}
        args = [a.strip() for a in str(c.get("args") or "").split(",") if a.strip()]
        yield _ko(
            instance,
            "macro",
            e,
            description=c.get("description"),
            properties={
                "definition": c.get("definition"),
                "args": args,
                "isEval": as_bool(c.get("iseval", False)),
            },
        )


EXTRACTORS: dict[str, Callable[[Transport, str], Iterable[tuple[dict, dict | None]]]] = {
    "apps": extract_apps,
    "indexes": extract_indexes,
    "savedSearches": extract_saved_searches,
    "dashboards": extract_dashboards,
    "macros": extract_macros,
}


def extract(transport: Transport, instance: str) -> ExtractResult:
    result = ExtractResult()
    for name, fn in EXTRACTORS.items():
        connector = f"splunk.{name}"
        try:
            count = 0
            for ent, edge in fn(transport, instance):
                result.entities.append(ent)
                if edge:
                    result.edges.append(edge)
                count += 1
            result.reports.append(
                {"connector": connector, "status": "ok", "counts": {"entities": count}}
            )
        except EndpointNotFound as exc:
            result.reports.append(
                {
                    "connector": connector,
                    "status": "skipped",
                    "message": f"endpoint not available: {exc}",
                }
            )
        except Exception as exc:  # report and continue with other extractors
            result.reports.append({"connector": connector, "status": "failed", "message": str(exc)})
    return result
