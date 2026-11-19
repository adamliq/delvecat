"""Apps, users and roles."""

from __future__ import annotations

import contextlib
from typing import Any

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from ...transport import EndpointForbidden, EndpointNotFound
from .common import Ctx, add_global, content, epoch_to_iso, permissions, ref, split_list


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
            permissions=permissions(e),
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


def extract_auth_tokens(ctx: Ctx, out: ExtractResult) -> int:
    """Splunk authentication tokens: who each one is for, when it expires and was last
    used, enabled or not. Splunk never lists a token's value, and neither does DelveCat;
    the client address it was last used from is not kept either."""
    n = 0
    for e in iter_entries(ctx.transport, "/services/authorization/tokens"):
        c = content(e)
        claims = c.get("claims") or {}
        user = str(claims.get("sub") or "").strip() or None
        audience = str(claims.get("aud") or "").strip() or None
        roles = claims.get("roles") or []
        issuer = str(claims.get("iss") or "")
        token_id = e["name"]
        ent = add_global(
            ctx,
            out,
            "authToken",
            token_id,
            displayName=f"{audience or 'Token'} ({token_id[:8]})",
            owner=user,
            disabled=str(c.get("status") or "enabled").lower() != "enabled",
            description=audience,
            properties={
                "user": user,
                "audience": audience,
                # "admin from <host id>": who created it.
                "issuedBy": issuer.split(" from ", 1)[0] or None,
                "issuedAt": epoch_to_iso(claims.get("iat")),
                "expiresAt": epoch_to_iso(claims.get("exp")),
                "neverExpires": not epoch_to_iso(claims.get("exp")),
                "notBefore": epoch_to_iso(claims.get("nbr")),
                "lastUsed": epoch_to_iso(c.get("lastUsed")),
                "status": c.get("status") or None,
                "identityProvider": claims.get("idp") or None,
                # ["*"]: the user's own roles; otherwise the token is limited to these.
                "restrictedRoles": None if roles in (["*"], "*", []) else split_list(roles),
            },
        )
        if user:
            out.refs.append(ref(ent["id"], "user", user, "contains", known_is_from=False))
        n += 1
    return n


def _auth_settings(ctx: Ctx, out: ExtractResult) -> None:
    """How people log in (Splunk, LDAP or SAML) and the LDAP strategies, on the instance.
    Strategies keep their name, SSL and state only: never bind DN, password or host."""
    info: dict[str, Any] = {}
    try:
        entries = list(
            iter_entries(
                ctx.transport,
                "/servicesNS/nobody/system/configs/conf-authentication/authentication",
            )
        )
        c = content(entries[0]) if entries else {}
        info["type"] = c.get("authType") or "Splunk"
        info["providers"] = split_list(c.get("authSettings"))
    except (EndpointNotFound, EndpointForbidden):
        pass
    with contextlib.suppress(EndpointNotFound, EndpointForbidden):
        info["ldapStrategies"] = [
            {
                "name": e["name"],
                "ssl": as_bool(content(e).get("SSLEnabled", False)),
                "disabled": as_bool(content(e).get("disabled", False)),
            }
            for e in iter_entries(ctx.transport, "/services/authentication/providers/LDAP")
        ] or None
    if info:
        out.instance_facts.setdefault("properties", {})["authentication"] = {
            k: v for k, v in info.items() if v not in (None, [])
        }


def extract_auth_groups(ctx: Ctx, out: ExtractResult) -> int:
    """Identity-provider groups mapped to Splunk roles (SAML and LDAP): whoever is in the
    group gets the roles. Members are counted, never listed (they are people's DNs)."""
    _auth_settings(ctx, out)
    n = 0
    for provider, path in (
        ("SAML", "/services/admin/SAML-groups"),
        ("LDAP", "/services/admin/LDAP-groups"),
    ):
        try:
            entries = list(iter_entries(ctx.transport, path))
        except (EndpointNotFound, EndpointForbidden):
            continue  # not configured, or not visible to this account
        for e in entries:
            c = content(e)
            roles = split_list(c.get("roles"))
            strategy = c.get("strategy") or None
            name = e["name"]
            members = c.get("users")
            ent = add_global(
                ctx,
                out,
                "authGroup",
                f"{provider.lower()}:{strategy + ':' if strategy else ''}{name}",
                displayName=name,
                properties={
                    "provider": provider,
                    "group": name,
                    "strategy": strategy,
                    "groupType": c.get("type") or None,
                    "roles": roles,
                    "memberCount": len(members) if isinstance(members, list) else None,
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
        # "federated:..." patterns grant federated indexes (federated search), not indexes.
        out.refs.extend(
            ref(
                ent["id"],
                "federatedIndex" if p.startswith("federated:") else "index",
                p,
                "grantsAccess",
                pattern=True,
            )
            for p in effective
        )
        out.refs.extend(ref(ent["id"], "role", r, "inherits") for r in imported)
        n += 1
    return n
