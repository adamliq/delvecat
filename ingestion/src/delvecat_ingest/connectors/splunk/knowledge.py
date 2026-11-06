"""Search-time knowledge objects: searches, dashboards, macros, eventtypes, tags,
props/transforms, lookups, KV store collections, data models, workflow actions."""

from __future__ import annotations

import json
from typing import Any

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from .common import (
    NS,
    Ctx,
    acl,
    add_global,
    add_ko,
    content,
    ref,
    split_list,
    stanza_sourcetype,
)


def _saved_search_kind(c: dict[str, Any]) -> str:
    if not as_bool(c.get("is_scheduled", False)):
        return "report"
    if c.get("alert_type", "always") != "always":
        return "alert"
    return "scheduledReport"


def extract_saved_searches(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/saved/searches"):
        c = content(e)
        actions = split_list(c.get("actions"))
        ent = add_ko(
            ctx,
            out,
            "savedSearch",
            e,
            properties={
                "kind": _saved_search_kind(c),
                "search": c.get("search"),
                "isScheduled": as_bool(c.get("is_scheduled", False)),
                "cronSchedule": c.get("cron_schedule") or None,
                "earliestTime": c.get("dispatch.earliest_time") or None,
                "latestTime": c.get("dispatch.latest_time") or None,
                "alertType": c.get("alert_type"),
                "alertSeverity": c.get("alert.severity"),
                "alertSuppress": as_bool(c.get("alert.suppress", False)),
                "actions": actions,
                "dispatchAs": c.get("dispatchAs"),
                "uiDispatchApp": c.get("request.ui_dispatch_app") or None,
                "visible": as_bool(c.get("is_visible", True)),
                "realtime": str(c.get("dispatch.earliest_time", "")).startswith("rt"),
            },
            observed={"nextScheduledTime": c.get("next_scheduled_time") or None},
        )
        if "summary_index" in actions:
            target = c.get("action.summary_index._name") or "summary"
            out.refs.append(ref(ent["id"], "index", target, "writes"))
        n += 1
    return n


def extract_dashboards(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/views"):
        c = content(e)
        source = str(c.get("eai:data") or "")
        if 'version="2"' in source:
            framework = "dashboardStudio"
        elif "<form" in source[:200]:
            framework = "simpleXmlForm"
        elif "<dashboard" in source[:200]:
            framework = "simpleXml"
        else:
            framework = "html" if "<view" in source[:200] else "other"
        add_ko(
            ctx,
            out,
            "dashboard",
            e,
            display_name=c.get("label"),
            properties={
                "framework": framework,
                "sourceBytes": len(source.encode()),
                "visible": as_bool(c.get("isVisible", True)),
                "isDashboard": as_bool(c.get("isDashboard", True)),
            },
        )
        n += 1
    return n


def extract_macros(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/admin/macros"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "macro",
            e,
            properties={
                "definition": c.get("definition"),
                "args": split_list(c.get("args")),
                "isEval": as_bool(c.get("iseval", False)),
                "validation": c.get("validation") or None,
            },
        )
        n += 1
    return n


def extract_eventtypes(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/saved/eventtypes"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "eventtype",
            e,
            properties={
                "search": c.get("search"),
                "priority": c.get("priority"),
                "color": c.get("color") or None,
                "tags": split_list(c.get("tags")),
            },
        )
        n += 1
    return n


def _fvtag_names(c: dict[str, Any]) -> list[str]:
    """tags.conf entries arrive either as ``tags: [...]`` or ``tag::<name>: enabled``."""
    names = split_list(c.get("tags"))
    for k, v in c.items():
        if k.startswith("tag::") and str(v).lower() == "enabled":
            names.append(k[len("tag::") :])
    return sorted(set(names))


def extract_tags(ctx: Ctx, out: ExtractResult) -> int:
    """Tags are global names; each field=value pair they are applied to becomes an edge."""
    applies: dict[str, list[str]] = {}
    for e in iter_entries(ctx.transport, f"{NS}/saved/fvtags"):
        pair = e["name"]
        app, _, _ = acl(e)
        for tag in _fvtag_names(content(e)):
            applies.setdefault(tag, []).append(pair)
            field, _, value = pair.partition("=")
            tid = f"{ctx.instance}:tag:{tag}"
            if field == "eventtype":
                out.refs.append(ref(tid, "eventtype", value, "mapsTo", app=app))
            elif field in ("sourcetype", "host", "source"):
                out.refs.append(ref(tid, field, value, "mapsTo"))
    for tag, pairs in applies.items():
        add_global(ctx, out, "tag", tag, properties={"appliesTo": sorted(set(pairs))})
    return len(applies)


# --- props.conf / transforms.conf -------------------------------------------------


def _props_ko(
    ctx: Ctx, out: ExtractResult, type_: str, e: dict[str, Any], properties: dict[str, Any]
) -> dict[str, Any]:
    c = content(e)
    stanza = c.get("stanza")
    ent = add_ko(
        ctx,
        out,
        type_,
        e,
        display_name=c.get("attribute") or None,
        properties={"stanza": stanza, "attribute": c.get("attribute"), **properties},
    )
    if st := stanza_sourcetype(stanza):
        out.refs.append(ref(ent["id"], "sourcetype", st, "uses", known_is_from=False))
    return ent


def extract_field_extractions(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/props/extractions"):
        c = content(e)
        kind = c.get("type") or ("Uses transform" if "REPORT-" in e["name"] else "Inline")
        ent = _props_ko(ctx, out, "fieldExtraction", e, {"kind": kind, "value": c.get("value")})
        if kind.lower().startswith("uses"):
            app, _, _ = acl(e)
            out.refs.extend(
                ref(ent["id"], "transform", t, "uses", app=app) for t in split_list(c.get("value"))
            )
        n += 1
    return n


def extract_field_aliases(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/props/fieldaliases"):
        c = content(e)
        aliases = {k[len("alias.") :]: v for k, v in c.items() if k.startswith("alias.")}
        _props_ko(ctx, out, "fieldAlias", e, {"aliases": aliases})
        n += 1
    return n


def extract_calculated_fields(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/props/calcfields"):
        c = content(e)
        _props_ko(
            ctx,
            out,
            "calculatedField",
            e,
            {"field": c.get("field.name"), "expression": c.get("value")},
        )
        n += 1
    return n


def extract_automatic_lookups(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/props/lookups"):
        c = content(e)
        inputs = {
            k.split(".", 3)[-1]: v for k, v in c.items() if k.startswith("lookup.field.input.")
        }
        outputs = {
            k.split(".", 3)[-1]: v for k, v in c.items() if k.startswith("lookup.field.output.")
        }
        ent = _props_ko(
            ctx,
            out,
            "automaticLookup",
            e,
            {
                "lookup": c.get("transform"),
                "inputFields": inputs,
                "outputFields": outputs,
                "overwrite": as_bool(c.get("overwrite", False)),
            },
        )
        if c.get("transform"):
            app, _, _ = acl(e)
            out.refs.append(ref(ent["id"], "lookup", c["transform"], "uses", app=app))
        n += 1
    return n


_TRANSFORM_KEYS = (
    "REGEX",
    "FORMAT",
    "SOURCE_KEY",
    "DEST_KEY",
    "DELIMS",
    "FIELDS",
    "MV_ADD",
    "CLEAN_KEYS",
    "KEEP_EMPTY_VALS",
    "CAN_OPTIMIZE",
)


def extract_transforms(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/transforms/extractions"):
        c = content(e)
        add_ko(ctx, out, "transform", e, properties={k: c.get(k) for k in _TRANSFORM_KEYS})
        n += 1
    return n


# --- lookups and KV store ------------------------------------------------------------


def extract_lookup_files(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/lookup-table-files"):
        add_ko(ctx, out, "lookup", e, properties={"kind": "file"})
        n += 1
    return n


def extract_lookup_definitions(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/transforms/lookups"):
        c = content(e)
        app, _, _ = acl(e)
        external = c.get("external_type") or None
        kind = {"kvstore": "kvstore", "geo": "geo", "python": "external"}.get(
            str(external), "external" if c.get("external_cmd") else "csv"
        )
        ent = add_ko(
            ctx,
            out,
            "lookup",
            e,
            properties={
                "kind": kind,
                "filename": c.get("filename") or None,
                "collection": c.get("collection") or None,
                "externalCmd": c.get("external_cmd") or None,
                "fields": split_list(c.get("fields_list")),
                "matchType": c.get("match_type") or None,
                "caseSensitive": as_bool(c.get("case_sensitive_match", True)),
                "maxMatches": c.get("max_matches"),
                "timeField": c.get("time_field") or None,
            },
        )
        if c.get("filename"):
            out.refs.append(ref(ent["id"], "lookup", c["filename"], "uses", app=app))
        if c.get("collection"):
            out.refs.append(ref(ent["id"], "kvCollection", c["collection"], "uses", app=app))
        n += 1
    return n


def extract_kv_collections(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/storage/collections/config"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "kvCollection",
            e,
            properties={
                "fields": {k[len("field.") :]: v for k, v in c.items() if k.startswith("field.")},
                "acceleratedFields": {
                    k[len("accelerated_fields.") :]: v
                    for k, v in c.items()
                    if k.startswith("accelerated_fields.")
                },
                "replicate": as_bool(c.get("replicate", False)),
                "enforceTypes": as_bool(c.get("enforceTypes", False)),
            },
        )
        n += 1
    return n


# --- data models -------------------------------------------------------------------


def _json_field(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def extract_data_models(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/datamodel/model"):
        c = content(e)
        model = _json_field(c.get("eai:data")) or _json_field(c.get("description")) or {}
        accel = _json_field(c.get("acceleration")) or {}
        datasets = []
        for obj in model.get("objects", []) if isinstance(model, dict) else []:
            constraints = [x.get("search") for x in obj.get("constraints", []) if x.get("search")]
            datasets.append(
                {
                    "name": obj.get("objectName"),
                    "displayName": obj.get("displayName"),
                    "parent": obj.get("parentName"),
                    "fields": [
                        f.get("fieldName") for f in obj.get("fields", []) if f.get("fieldName")
                    ],
                    "constraint": " ".join(constraints) or None,
                }
            )
        desc = model.get("description") if isinstance(model, dict) else None
        add_ko(
            ctx,
            out,
            "dataModel",
            e,
            display_name=c.get("displayName") or (model.get("displayName") if model else None),
            description=desc if isinstance(desc, str) else None,
            properties={
                "datasets": datasets,
                "fieldCount": sum(len(d["fields"]) for d in datasets),
                "accelerated": as_bool(accel.get("enabled", False)),
                "accelerationEarliest": accel.get("earliest_time"),
                "accelerationCron": accel.get("cron_schedule"),
            },
        )
        n += 1
    return n


def extract_workflow_actions(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/workflow-actions"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "workflowAction",
            e,
            display_name=c.get("label") or None,
            properties={
                "kind": c.get("type"),
                "fields": split_list(c.get("fields")),
                "linkUri": c.get("link.uri") or None,
                "search": c.get("search.search_string") or None,
                "displayLocation": c.get("display_location"),
            },
        )
        n += 1
    return n


def extract_sourcetype_definitions(ctx: Ctx, out: ExtractResult) -> int:
    """Sourcetypes defined in props.conf (global name; ``definedIn`` lists the apps)."""
    parsing = (
        "SHOULD_LINEMERGE",
        "LINE_BREAKER",
        "TIME_PREFIX",
        "TIME_FORMAT",
        "MAX_TIMESTAMP_LOOKAHEAD",
        "TRUNCATE",
        "TZ",
        "KV_MODE",
        "INDEXED_EXTRACTIONS",
        "CHARSET",
        "NO_BINARY_CHECK",
        "category",
        "pulldown_type",
    )
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/saved/sourcetypes"):
        c = content(e)
        app, _, _ = acl(e)
        add_global(
            ctx,
            out,
            "sourcetype",
            e["name"],
            app=app,
            description=c.get("description") or None,
            updatedAt=e.get("updated"),
            properties={
                "definedIn": [app] if app else [],
                "parsing": {k: c.get(k) for k in parsing if c.get(k) not in (None, "")},
            },
        )
        n += 1
    return n
