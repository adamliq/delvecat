"""Shared helpers for Splunk platform extractors."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ...model import ExtractResult, Ref, Target, edge, entity, fqn
from ...splunk_rest import as_bool
from ...transport import Transport

NS = "/servicesNS/-/-"

# props.conf stanza prefixes that do not name a sourcetype.
_NON_SOURCETYPE_STANZA = ("source::", "host::", "rule::", "delayedrule::")


@dataclass
class Options:
    inventory_window: str = "-7d"
    max_hosts: int = 5000
    max_sources: int = 5000
    max_forwarders: int = 10000
    fields: bool = False
    max_field_sourcetypes: int = 100
    field_sample_events: int = 1000
    usage: bool = True
    usage_window: str = "-30d"  # audit, dashboard views, license
    health_window: str = "-7d"  # scheduler, parsing warnings
    volume_days: int = 14
    max_adhoc_searches: int = 5000


@dataclass
class Ctx:
    transport: Transport
    instance: str
    options: Options = field(default_factory=Options)
    cache: dict[str, Any] = field(default_factory=dict)  # responses shared by extractors


def acl(entry: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    a = entry.get("acl") or {}
    return a.get("app"), a.get("owner"), a.get("sharing")


def permissions(entry: dict[str, Any]) -> dict[str, list[str]] | None:
    """Roles that may read / write the object (``*`` means every role)."""
    perms = (entry.get("acl") or {}).get("perms") or {}
    out = {k: sorted(set(split_list(perms.get(k)))) for k in ("read", "write") if perms.get(k)}
    return out or None


def content(entry: dict[str, Any]) -> dict[str, Any]:
    return entry.get("content") or {}


def split_list(value: Any) -> list[str]:
    """Splunk returns lists either as JSON arrays or comma/semicolon separated strings."""
    if value is None or value == "":
        return []
    items = value if isinstance(value, list) else [value]
    return [p.strip() for v in items for p in str(v).replace(";", ",").split(",") if p.strip()]


def epoch_to_iso(value: Any) -> str | None:
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return datetime.fromtimestamp(ts, UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def app_edge(ctx: Ctx, app: str | None, child_id: str) -> dict[str, Any] | None:
    if not app:
        return None
    return edge(fqn(ctx.instance, "app", app), child_id, "contains")


def add_ko(
    ctx: Ctx,
    out: ExtractResult,
    type_: str,
    entry: dict[str, Any],
    *,
    properties: dict[str, Any],
    observed: dict[str, Any] | None = None,
    description: str | None = None,
    display_name: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Add an app-scoped knowledge object plus its app→object edge; return the entity."""
    app, owner, sharing = acl(entry)
    c = content(entry)
    name = name or entry["name"]
    eid = fqn(ctx.instance, type_, name, app=app or "unknown", owner=owner, sharing=sharing)
    ent = entity(
        id=eid,
        type=type_,
        name=name,
        displayName=display_name,
        instance=ctx.instance,
        app=app,
        owner=owner,
        sharing=sharing,
        disabled=as_bool(c.get("disabled", False)),
        description=description or c.get("description") or None,
        updatedAt=entry.get("updated"),
        properties=properties,
        observed=observed,
        permissions=permissions(entry),
    )
    out.entities.append(ent)
    if e := app_edge(ctx, app, eid):
        out.edges.append(e)
    return ent


def add_global(
    ctx: Ctx,
    out: ExtractResult,
    type_: str,
    name: str,
    *,
    app: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    ent = entity(
        id=fqn(ctx.instance, type_, name),
        type=type_,
        name=name,
        instance=ctx.instance,
        app=app,
        **kwargs,
    )
    out.entities.append(ent)
    if e := app_edge(ctx, app, ent["id"]):
        out.edges.append(e)
    return ent


def stanza_sourcetype(stanza: str | None) -> str | None:
    if not stanza or stanza.startswith(_NON_SOURCETYPE_STANZA):
        return None
    return stanza


def ref(
    known: str,
    type_: str,
    name: str,
    edge_type: str,
    *,
    app: str | None = None,
    pattern: bool = False,
    known_is_from: bool = True,
) -> Ref:
    return Ref(known, Target(type_, name, app, pattern), edge_type, known_is_from)
