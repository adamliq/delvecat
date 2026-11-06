"""Apps, users and roles."""

from __future__ import annotations

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from .common import Ctx, add_global, content, ref, split_list


def extract_apps(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/apps/local"):
        c = content(e)
        add_global(
            ctx,
            out,
            "app",
            e["name"],
            displayName=c.get("label"),
            disabled=as_bool(c.get("disabled", False)),
            description=c.get("description"),
            updatedAt=e.get("updated"),
            properties={
                "version": c.get("version"),
                "author": c.get("author"),
                "visible": as_bool(c.get("visible", True)),
                "configured": as_bool(c.get("configured", False)),
            },
        )
        n += 1
    # Objects in etc/system report app "system", which apps/local does not list.
    add_global(
        ctx,
        out,
        "app",
        "system",
        displayName="System (etc/system)",
        description="Splunk's system-level configuration scope.",
        properties={"builtin": True, "visible": False},
    )
    return n + 1


def extract_users(ctx: Ctx, out: ExtractResult) -> int:
    """Users: roles and authentication type. Email addresses are deliberately not collected."""
    n = 0
    for e in iter_entries(ctx.transport, "/services/authentication/users"):
        c = content(e)
        roles = split_list(c.get("roles"))
        ent = add_global(
            ctx,
            out,
            "user",
            e["name"],
            displayName=c.get("realname") or None,
            updatedAt=e.get("updated"),
            properties={
                "roles": roles,
                "authType": c.get("type"),
                "defaultApp": c.get("defaultApp"),
                "locked": as_bool(c.get("locked-out", False)),
            },
        )
        out.refs.extend(ref(ent["id"], "role", r, "memberOf") for r in roles)
        n += 1
    return n


def extract_roles(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/authorization/roles"):
        c = content(e)
        allowed = split_list(c.get("srchIndexesAllowed"))
        imported = split_list(c.get("imported_roles"))
        capabilities = split_list(c.get("capabilities"))
        ent = add_global(
            ctx,
            out,
            "role",
            e["name"],
            updatedAt=e.get("updated"),
            properties={
                "importedRoles": imported,
                "capabilities": capabilities,
                "importedCapabilities": split_list(c.get("imported_capabilities")),
                "srchIndexesAllowed": allowed,
                "srchIndexesDefault": split_list(c.get("srchIndexesDefault")),
                "importedSrchIndexesAllowed": split_list(c.get("imported_srchIndexesAllowed")),
                "srchFilter": c.get("srchFilter") or None,
                "srchTimeWin": c.get("srchTimeWin"),
                "srchJobsQuota": c.get("srchJobsQuota"),
                "srchDiskQuota": c.get("srchDiskQuota"),
                "defaultApp": c.get("defaultApp") or None,
            },
        )
        # Effective access: the role's own patterns plus those inherited from imported roles.
        effective = sorted(set(allowed) | set(split_list(c.get("imported_srchIndexesAllowed"))))
        out.refs.extend(ref(ent["id"], "index", p, "grantsAccess", pattern=True) for p in effective)
        out.refs.extend(ref(ent["id"], "role", r, "inherits") for r in imported)
        n += 1
    return n
