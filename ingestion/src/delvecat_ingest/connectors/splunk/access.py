"""Apps, users and roles."""

from __future__ import annotations

import contextlib
from typing import Any

from ...model import ExtractResult, edge, fqn
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
    used, enabled or not. Splunk never lists a token's value, and neither does Licoryx Delvecat;
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


# authentication.conf stanzas that are not LDAP strategies or role maps.
_AUTH_SPECIAL = {"authentication", "auth-tokens", "cacheTiming", "splunk_auth", "secrets"}


def _is_ldap(name: str, c: dict[str, Any]) -> bool:
    return (
        name not in _AUTH_SPECIAL
        and not name.startswith("roleMap_")
        and "host" in c
        and any(k in c for k in ("userBaseDN", "groupBaseDN", "userNameAttribute"))
    )


def _int(v: Any) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _auth_conf(ctx: Ctx) -> dict[str, dict[str, Any]]:
    """authentication.conf by stanza; when the file cannot be listed, its [authentication]
    stanza and Splunk's list of LDAP strategies."""
    base = "/servicesNS/nobody/system/configs/conf-authentication"
    with contextlib.suppress(EndpointNotFound, EndpointForbidden):
        conf = {e["name"]: content(e) for e in iter_entries(ctx.transport, base)}
        if conf:
            return conf
    conf = {}
    with contextlib.suppress(EndpointNotFound, EndpointForbidden):
        for e in iter_entries(ctx.transport, f"{base}/authentication"):
            conf["authentication"] = content(e)
    with contextlib.suppress(EndpointNotFound, EndpointForbidden):
        for e in iter_entries(ctx.transport, "/services/authentication/providers/LDAP"):
            conf[e["name"]] = {"host": None, "userNameAttribute": None, **content(e)}
    return conf


def _strategies(ctx: Ctx, out: ExtractResult, conf: dict[str, dict[str, Any]]) -> list[str]:
    """How people log in, and each LDAP strategy as an object. Read from authentication.conf,
    so the LDAP server need not answer. Kept: port, TLS, how users and groups are looked
    up, limits. Never kept: the server's name, bind DN, bind password, base DNs, filters."""
    main = conf.get("authentication") or {}
    active = split_list(main.get("authSettings"))
    info: dict[str, Any] = {}
    if conf:
        info["type"] = main.get("authType") or "Splunk"
        info["providers"] = active
    names = []
    for name, c in conf.items():
        if not _is_ldap(name, c):
            continue
        names.append(name)
        add_global(
            ctx,
            out,
            "authStrategy",
            name,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "provider": "LDAP",
                "active": name in active and str(info.get("type", "")).upper() == "LDAP",
                "order": active.index(name) + 1 if name in active else None,
                "port": _int(c.get("port")),
                "ssl": as_bool(c.get("SSLEnabled", False)),
                "verifyServerCert": as_bool(c.get("sslVerifyServerCert", False)),
                "nestedGroups": as_bool(c.get("nestedGroups", False)),
                "dynamicGroups": bool(c.get("dynamicGroupFilter")) or None,
                "anonymousReferrals": as_bool(c.get("anonymous_referrals", True)),
                "userNameAttribute": c.get("userNameAttribute") or None,
                "realNameAttribute": c.get("realNameAttribute") or None,
                "emailAttribute": c.get("emailAttribute") or None,
                "groupNameAttribute": c.get("groupNameAttribute") or None,
                "groupMemberAttribute": c.get("groupMemberAttribute") or None,
                "groupMappingAttribute": c.get("groupMappingAttribute") or None,
                "userFilter": bool(c.get("userBaseFilter")) or None,
                "groupFilter": bool(c.get("groupBaseFilter")) or None,
                "sizeLimit": _int(c.get("sizelimit")),
                "timeLimitSecs": _int(c.get("timelimit")),
                "networkTimeoutSecs": _int(c.get("network_timeout")),
                "pageLimit": _int(c.get("pagelimit")),
                "rangeRetrieval": as_bool(c.get("enableRangeRetrieval", False)),
            },
        )
    if names:  # kept on the instance too, for older readers of the catalog
        info["ldapStrategies"] = [
            {
                "name": n,
                "ssl": as_bool(conf[n].get("SSLEnabled", False)),
                "disabled": as_bool(conf[n].get("disabled", False)),
            }
            for n in names
        ]
    if info:
        out.instance_facts.setdefault("properties", {})["authentication"] = {
            k: v for k, v in info.items() if v not in (None, [])
        }
    return names


def _role_maps(conf: dict[str, dict[str, Any]]) -> dict[tuple[str, str | None, str], list[str]]:
    """(provider, strategy, group) -> roles, from the roleMap_<strategy> stanzas."""
    out: dict[tuple[str, str | None, str], list[str]] = {}
    for name, c in conf.items():
        if not name.startswith("roleMap_"):
            continue
        strategy = name[len("roleMap_") :]
        provider, strat = ("SAML", None) if strategy.upper() == "SAML" else ("LDAP", strategy)
        for role, groups in c.items():
            if role == "disabled" or role.startswith("eai:") or not isinstance(groups, str):
                continue
            for g in (x.strip() for x in groups.split(";")):
                if g:
                    out.setdefault((provider, strat, g), []).append(role)
    return out


def extract_auth_groups(ctx: Ctx, out: ExtractResult) -> int | tuple[int, str]:
    """LDAP strategies, and identity-provider groups mapped to Splunk roles (SAML and LDAP):
    whoever is in the group gets the roles. The mapping comes from authentication.conf
    (``roleMap_<strategy>``), so it is complete even when the LDAP server does not answer;
    Splunk's group lists add each group's type and how many members it has (counted, never
    listed: they are people's DNs) and show mapped groups the directory does not have."""
    conf = _auth_conf(ctx)
    strategies = set(_strategies(ctx, out, conf))
    mapped = _role_maps(conf)
    seen: dict[tuple[str, str | None, str], dict[str, Any]] = {}
    unreachable: list[str] = []
    listed: set[str] = set()  # providers whose group list was read
    for provider, path in (
        ("SAML", "/services/admin/SAML-groups"),
        ("LDAP", "/services/admin/LDAP-groups"),
    ):
        try:
            entries = list(iter_entries(ctx.transport, path))
        except (EndpointNotFound, EndpointForbidden):
            continue  # not configured, or not visible to this account
        except Exception:  # noqa: BLE001 - Splunk answers 500 when LDAP is unreachable
            unreachable.append(provider)
            continue
        listed.add(provider)
        for e in entries:
            c = content(e)
            strategy = c.get("strategy") or None
            seen[(provider, strategy if provider == "LDAP" else None, e["name"])] = c
    n = 0
    keys = sorted(set(mapped) | set(seen), key=lambda k: (k[0], k[1] or "", k[2]))
    for provider, strategy, name in keys:
        c = seen.get((provider, strategy, name)) or {}
        roles = sorted(
            set(mapped.get((provider, strategy, name), [])) | set(split_list(c.get("roles")))
        )
        members = c.get("users")
        in_directory = None
        if provider == "LDAP" and provider in listed:
            in_directory = (provider, strategy, name) in seen
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
                "foundInDirectory": in_directory,
            },
        )
        out.refs.extend(ref(ent["id"], "role", r, "memberOf") for r in roles)
        if strategy and strategy in strategies:
            out.edges.append(
                edge(fqn(ctx.instance, "authStrategy", strategy), ent["id"], "contains")
            )
        n += 1
    if unreachable:
        return n, (
            f"{' and '.join(unreachable)} group lists not readable (LDAP server not reachable?): "
            "mappings come from authentication.conf; member counts are missing"
        )
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
