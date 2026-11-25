"""Capabilities: what roles may do in Splunk (authorize.conf ``capability::<name>``).

Each capability is a catalog object, built-in or defined by an app, marked high risk
when it can change who may do what, read secrets, run code, delete data or change the
platform. Roles are linked to the capabilities they grant themselves (``grantsAccess``);
roles that inherit them, and users, are worked out from those links.
"""

from __future__ import annotations

from ...model import ExtractResult
from ...splunk_rest import iter_entries
from ...transport import EndpointForbidden, EndpointNotFound
from .common import NS, Ctx, acl, add_global, content, ref, split_list

# High-risk capabilities and why (Splunk's own "risky" list, plus ones that change access,
# read secrets, run code or delete data).
HIGH_RISK: dict[str, str] = {
    "admin_all_objects": "read and change every knowledge object, whoever owns it",
    "change_authentication": "change how users sign in (LDAP, SAML, passwords)",
    "edit_roles": "create and change roles, so grant itself anything",
    "edit_roles_grantable": "give users roles it can grant",
    "edit_user": "create users and change their roles and passwords",
    "edit_tokens_all": "create and change authentication tokens for any user",
    "edit_tokens_settings": "turn token authentication on and off",
    "delete_by_keyword": "delete events with | delete",
    "list_storage_passwords": "read stored passwords and secrets of apps",
    "edit_storage_passwords": "change stored passwords and secrets of apps",
    "install_apps": "install apps, which can run code",
    "rest_apps_management": "install and manage apps over REST",
    "edit_scripted": "add scripted inputs, which run programs",
    "run_debug_commands": "run debug search commands",
    "run_custom_command": "run custom search commands",
    "run_dump": "write raw events to files with | dump",
    "run_sendalert": "run alert actions from searches",
    "run_msearch": "search metrics without index restrictions",
    "restart_splunkd": "restart Splunk",
    "edit_server": "change server settings",
    "edit_httpauths": "change and delete user sessions",
    "edit_encryption_key_provider": "change encryption key providers",
    "edit_deployment_server": "change what the deployment server sends to forwarders",
    "edit_forwarders": "change forwarding settings",
    "edit_indexer_cluster": "change indexer clustering",
    "edit_search_head_clustering": "change search head clustering",
    "edit_web_settings": "change Splunk Web settings",
    "embed_report": "publish reports so anyone with the link can see them",
    "never_lockout": "never be locked out after failed sign-ins",
    "never_expire": "keep a password that never expires",
    "edit_field_filter": "change field filters, which mask sensitive data",
    "edit_fields_filter_exemption": "exempt roles from field filters",
}
CORE_APPS = {"system", "search", "launcher"}


def risk_of(name: str) -> str | None:
    return HIGH_RISK.get(name)


def extract_capabilities(ctx: Ctx, out: ExtractResult) -> int:
    """Every capability (authorize.conf), with the app that defines it, and the roles
    granting it."""
    defined: dict[str, str | None] = {}
    try:
        for e in iter_entries(ctx.transport, f"{NS}/configs/conf-authorize"):
            if e["name"].startswith("capability::"):
                defined[e["name"].split("::", 1)[1]] = acl(e)[0]
    except (EndpointNotFound, EndpointForbidden):
        pass
    if not defined:
        try:
            for e in iter_entries(ctx.transport, "/services/authorization/capabilities"):
                for name in split_list(content(e).get("capabilities")):
                    defined.setdefault(name, None)
        except (EndpointNotFound, EndpointForbidden):
            pass
    # Capabilities roles grant that no conf file defines here (Splunk Cloud, removed apps).
    for role in (e for e in out.entities if e["type"] == "role"):
        for name in (role.get("properties") or {}).get("capabilities") or []:
            defined.setdefault(name, None)
    for name, app in sorted(defined.items()):
        add_global(
            ctx,
            out,
            "capability",
            name,
            app=app if app not in (None, "system") else None,
            description=HIGH_RISK.get(name),
            properties={
                "risk": "high" if name in HIGH_RISK else None,
                "builtin": True if app in CORE_APPS or app is None else None,
                "definedIn": app,
            },
        )
    for role in (e for e in out.entities if e["type"] == "role"):
        for name in (role.get("properties") or {}).get("capabilities") or []:
            out.refs.append(ref(role["id"], "capability", name, "grantsAccess"))
    return len(defined)
