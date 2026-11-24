"""Knowledge objects beyond searches and fields: sourcetype renames, field filters,
fields.conf, app navigation menus, time range presets, prebuilt panels, visualizations,
multikv tables and segmenters. All read-only REST reads; none hold secrets."""

from __future__ import annotations

import re
from typing import Any

from defusedxml import ElementTree as SafeET  # navigation menus are user content

from ...dashboards import parse_panel
from ...model import ExtractResult, edge, fqn
from ...splunk_rest import as_bool, iter_entries
from ...transport import EndpointForbidden, EndpointNotFound
from .common import NS, Ctx, acl, add_global, add_ko, content, ref, split_list

# Apps whose objects ship with Splunk (default menus, time ranges, chart types).
_CORE_APPS = {"search", "system", "launcher", "splunk_visualizations", "splunk-dashboard-studio"}


def _bool(v: Any) -> bool | None:
    return None if v in (None, "") else as_bool(v)


def _builtin(e: dict[str, Any]) -> bool | None:
    return True if acl(e)[0] in _CORE_APPS else None


def extract_sourcetype_renames(ctx: Ctx, out: ExtractResult) -> int:
    """props.conf rename: searches see the data under the new name. The new name becomes
    a sourcetype of its own (searches name it), linked from the indexed one by mapsTo."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/props/sourcetype-rename"):
        c = content(e)
        old, new = c.get("stanza") or e["name"], c.get("value")
        if not new or not old or old == "default" or "::" in old:
            continue
        app = acl(e)[0]
        add_global(ctx, out, "sourcetype", old, properties={"renamedTo": new, "renamedIn": app})
        add_global(ctx, out, "sourcetype", new, properties={"renamedFrom": [old]})
        out.edges.append(
            edge(
                fqn(ctx.instance, "sourcetype", old), fqn(ctx.instance, "sourcetype", new), "mapsTo"
            )
        )
        n += 1
    return n


_ACTION = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=\s*(.+?)\s*$', re.S)


def parse_field_filter_action(action: str | None) -> dict[str, Any]:
    """'"ssn"="xxx"' -> field ssn, replace with "xxx"; null(), sha256(), sha512(), sed()."""
    m = _ACTION.match(action or "")
    if not m:
        return {"raw": action} if action else {}
    field, op = m.group(1).replace('\\"', '"'), m.group(2)
    low = op.lower()
    if low == "null()":
        return {"field": field, "action": "remove"}
    if low in ("sha256()", "sha512()"):
        return {"field": field, "action": "hash", "hash": low[:-2]}
    if low.startswith("sed("):
        return {"field": field, "action": "sed", "sed": op[4:-1].strip().strip('"')}
    return {"field": field, "action": "replace", "replacement": op.strip('"')}


def builder_roles(ctx: Ctx) -> list[str] | None:
    """Roles of the account this build runs as (None if Splunk does not say)."""
    try:
        entry = ctx.transport.get("/services/authentication/current-context")["entry"][0]
    except (EndpointNotFound, EndpointForbidden, KeyError, IndexError, TypeError):
        return None
    roles = content(entry).get("roles")
    return [str(r) for r in roles] if isinstance(roles, list) else None


def extract_field_filters(ctx: Ctx, out: ExtractResult) -> int:
    """Field filters (Splunk 9.4 and later): remove, hash or replace a field's values in
    search results for every role not exempt. A filter that applies to the account
    running the build also limits what the build sees (and blocks some commands)."""
    filters = list(iter_entries(ctx.transport, "/services/authorization/fieldfilters"))
    roles = builder_roles(ctx) if filters else None
    n = 0
    for e in filters:
        c = content(e)
        limit_type, _, limit_values = str(c.get("limit") or "").partition("::")
        ent = add_global(
            ctx,
            out,
            "fieldFilter",
            e["name"],
            description=c.get("description") or None,
            properties={
                **parse_field_filter_action(c.get("action")),
                "indexes": split_list(c.get("index")) or None,
                "limit": {"type": limit_type, "values": split_list(limit_values)}
                if limit_type and limit_values
                else None,
                "roleExemptions": split_list(c.get("roleExemptions")) or None,
                # True when no role of the building account is exempt.
                "appliesToBuilder": (
                    not set(roles) & set(split_list(c.get("roleExemptions")))
                    if roles is not None
                    else None
                ),
            },
        )
        for index in split_list(c.get("index")):
            out.refs.append(ref(ent["id"], "index", index, "uses"))
        if limit_type == "sourcetype":
            for st in split_list(limit_values):
                out.refs.append(ref(ent["id"], "sourcetype", st, "uses"))
        n += 1
    return n


def extract_field_definitions(ctx: Ctx, out: ExtractResult) -> int:
    """fields.conf: fields indexed at index time (INDEXED), fields whose values are not
    in the raw text (INDEXED_VALUE = false), and tokenizers."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/configs/conf-fields"):
        c = content(e)
        if e["name"] == "default":
            continue
        add_global(
            ctx,
            out,
            "fieldDefinition",
            e["name"],
            app=acl(e)[0],
            properties={
                "indexed": _bool(c.get("INDEXED")),
                "indexedValue": c.get("INDEXED_VALUE") or None,
                "tokenizer": c.get("TOKENIZER") or None,
                "builtin": _builtin(e),
            },
        )
        n += 1
    return n


def _nav_items(source: str) -> tuple[list[str], list[str], str | None]:
    """(views, saved searches, default view) a navigation menu names."""
    try:
        root = SafeET.fromstring(source or "")
    except Exception:  # noqa: BLE001 - user content
        return [], [], None
    views, saved, default = [], [], None
    for el in root.iter():
        if el.tag == "view" and el.get("name"):
            views.append(el.get("name"))
            if el.get("default", "").lower() in ("true", "1"):
                default = el.get("name")
        elif el.tag == "saved" and el.get("name"):
            saved.append(el.get("name"))
    return list(dict.fromkeys(views)), list(dict.fromkeys(saved)), default


def extract_navigation(ctx: Ctx, out: ExtractResult) -> int:
    """Each app's navigation menu: the dashboards and reports people reach from it."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/nav"):
        c = content(e)
        views, saved, default = _nav_items(str(c.get("eai:data") or ""))
        app = acl(e)[0]
        ent = add_ko(
            ctx,
            out,
            "navMenu",
            e,
            display_name=f"{app} menu" if app else None,
            properties={
                "views": views or None,
                "savedSearches": saved or None,
                "defaultView": default,
                "color": c.get("color") or None,
            },
        )
        for v in views:
            out.refs.append(ref(ent["id"], "dashboard", v, "uses", app=app))
        for s in saved:
            out.refs.append(ref(ent["id"], "savedSearch", s, "uses", app=app))
        n += 1
    return n


def extract_time_ranges(ctx: Ctx, out: ExtractResult) -> int:
    """Time range presets (times.conf) offered in the time picker."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/times"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "timeRange",
            e,
            display_name=c.get("label") or None,
            properties={
                "earliest": c.get("earliest_time") or None,
                "latest": c.get("latest_time") or None,
                "header": c.get("header_label") or None,
                "order": c.get("order"),
                "subMenu": c.get("is_sub_menu") or None,
                "builtin": _builtin(e),
            },
        )
        n += 1
    return n


def extract_panels(ctx: Ctx, out: ExtractResult) -> int:
    """Prebuilt panels Simple XML dashboards include with <panel ref=...>; their searches
    are analysed like a dashboard's."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/panels"):
        c = content(e)
        searches, warnings = parse_panel(str(c.get("eai:data") or ""))
        ent = add_ko(
            ctx,
            out,
            "panel",
            e,
            display_name=c.get("panel.title") or None,
            properties={"searches": [s.as_dict() for s in searches]},
        )
        if warnings:
            ent["lineage"] = {"warnings": warnings}
        n += 1
    return n


def extract_visualizations(ctx: Ctx, out: ExtractResult) -> int:
    """Visualizations (chart types), built-in and from apps."""
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/data/ui/visualizations"):
        c = content(e)
        add_ko(
            ctx,
            out,
            "visualization",
            e,
            display_name=c.get("label") or None,
            description=c.get("description") or None,
            properties={
                "builtin": _builtin(e),
                "allowUserSelection": as_bool(c["allow_user_selection"])
                if c.get("allow_user_selection") not in (None, "")
                else None,
            },
        )
        n += 1
    return n


def extract_multikv(ctx: Ctx, out: ExtractResult) -> int:
    """multikv.conf: how the multikv command reads table-shaped events."""
    return _conf_settings(ctx, out, "conf-multikv", "multikvTable")


def extract_segmenters(ctx: Ctx, out: ExtractResult) -> int:
    """segmenters.conf: how events are broken into searchable terms."""
    return _conf_settings(ctx, out, "conf-segmenters", "segmenter")


def _conf_settings(ctx: Ctx, out: ExtractResult, conf: str, type_: str) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/configs/{conf}"):
        if e["name"] == "default":
            continue
        c = content(e)
        settings = {
            k: v
            for k, v in c.items()
            if not k.startswith("eai:") and k != "disabled" and v not in (None, "")
        }
        add_global(
            ctx,
            out,
            type_,
            e["name"],
            app=acl(e)[0],
            properties={"settings": settings or None, "builtin": _builtin(e)},
        )
        n += 1
    return n


EXTRA_EXTRACTORS = {
    "sourcetypeRenames": extract_sourcetype_renames,
    "fieldFilters": extract_field_filters,
    "fieldDefinitions": extract_field_definitions,
    "navigation": extract_navigation,
    "timeRanges": extract_time_ranges,
    "panels": extract_panels,
    "visualizations": extract_visualizations,
    "multikv": extract_multikv,
    "segmenters": extract_segmenters,
}
