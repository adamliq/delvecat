"""Microsoft add-ons: Splunk Add-on for Microsoft Cloud Services, Microsoft Office 365,
Microsoft Azure and Microsoft Security.

- Their inputs (read with the other modular inputs) are recognised: which add-on, which
  Microsoft service they read, the account or tenant they use, and the values of
  settings that only name things.
- Their accounts and tenants (the add-ons' Configuration pages) are catalogued as
  ``addOnAccount``: tenant id, client (application) id, cloud environment. Client
  secrets, passwords, certificates and tokens are never read.

Endpoints are the add-ons' own REST handlers (UCC), as their setup pages use them.
"""

from __future__ import annotations

import re
from typing import Any

from ...model import ExtractResult
from ...splunk_rest import iter_entries
from ...transport import EndpointForbidden, EndpointNotFound
from .common import Ctx, add_ko, content

# app -> (add-on name, its account/tenant configuration endpoint, what it calls one)
ADD_ONS: dict[str, tuple[str, str, str]] = {
    "Splunk_TA_microsoft-cloudservices": (
        "Splunk Add-on for Microsoft Cloud Services",
        "splunk_ta_mscs_azureaccount",
        "Azure App Account",
    ),
    "splunk_ta_o365": (
        "Splunk Add-on for Microsoft Office 365",
        "splunk_ta_o365_tenants",
        "Tenant",
    ),
    "TA-MS-AAD": ("Splunk Add-on for Microsoft Azure", "TA_MS_AAD_account", "Account"),
    "Splunk_TA_MS_Security": (
        "Splunk Add-on for Microsoft Security",
        "Splunk_TA_MS_Security_account",
        "Account",
    ),
}
_KINDS = re.compile(
    r"^(mscs_|azure_|ms_aad_|ms_graph_|o365_|splunk_ta_o365|microsoft_|ms_security)", re.I
)

# Service an input reads, by words in its kind; the first match wins (specific first).
SERVICES: tuple[tuple[str, str], ...] = (
    ("event_hub", "Event Hubs"),
    ("storage_blob", "Azure Storage (Blob)"),
    ("storage_table", "Azure Storage (Table)"),
    ("365_defender", "Microsoft 365 Defender incidents"),
    ("defender_endpoint_atp", "Defender for Endpoint alerts"),
    ("defender_endpoint_machines", "Defender for Endpoint devices"),
    ("defender_endpoint_simulations", "Attack simulation training"),
    ("threat_intelligence", "Defender Threat Intelligence"),
    ("cloud_application_security", "Defender for Cloud Apps"),
    ("security_center", "Defender for Cloud"),
    ("ms_graph_security", "Microsoft Graph security alerts"),
    ("identity_protection", "Entra ID Identity Protection"),
    ("signins", "Entra ID sign-ins"),
    ("aad_audit", "Entra ID audit logs"),
    ("audit_logs", "Entra ID audit logs (Graph)"),
    ("entra_id", "Entra ID"),
    ("aad_user", "Entra ID users"),
    ("aad_group", "Entra ID groups"),
    ("aad_app", "Entra ID applications"),
    ("aad_device", "Entra ID devices"),
    ("mgmt_activity", "Office 365 Management Activity (audit)"),
    ("management_activity", "Office 365 Management Activity (audit)"),
    ("servicehealth", "Service health and communications"),
    ("msg_trace", "Exchange Online message trace"),
    ("message_trace", "Exchange Online message trace"),
    ("mailbox", "Mailbox usage reports"),
    ("one_drive", "OneDrive usage reports"),
    ("sharepoint", "SharePoint usage reports"),
    ("teams", "Teams usage reports"),
    ("yammer", "Viva Engage (Yammer) usage reports"),
    ("office_365", "Office 365 usage reports"),
    ("kql", "Log Analytics (KQL)"),
    ("metrics", "Azure Monitor metrics"),
    ("azure_audit", "Azure activity log"),
    ("consumption", "Azure cost and usage"),
    ("reservation_recommendation", "Azure reservation recommendations"),
    ("resource_graph", "Azure Resource Graph"),
    ("topology", "Azure topology"),
    ("subscription", "Azure subscriptions"),
    ("resource_group", "Azure resource groups"),
    ("virtual_network", "Azure virtual networks"),
    ("azure_comp", "Azure compute (virtual machines)"),
    ("azure_resource", "Azure resources"),
)

# Input settings that name the account or tenant used.
ACCOUNT_SETTINGS = ("account", "azure_app_account", "tenant_name", "azure_account")
# Input settings whose values only name things (no keys or secrets).
NAMING_SETTINGS = (
    *ACCOUNT_SETTINGS,
    "storage_account",
    "event_hub_namespace",
    "event_hub_name",
    "consumer_group",
    "container_name",
    "table_list",
    "blob_list",
    "prefix",
    "environment",
    "resource_type",
    "resource_group_list",
    "namespaces",
    "metric_namespace",
    "subscription_id",
    "tenant_id",
    "workspace_id",
    "content_type",
    "endpoint",
)
# Account settings kept (identifiers, not secrets). TA-MS-AAD stores the client id as
# "username" and the client secret as "password".
ACCOUNT_KEEP = {
    "tenant_id": "tenantId",
    "client_id": "clientId",
    "username": "clientId",
    "account_class_type": "cloudEnvironment",
    "environment": "cloudEnvironment",
    "azure_environment": "cloudEnvironment",
    "endpoint": "cloudEnvironment",
    "tenant_subdomain": "tenantSubdomain",
    "tenant_data_center": "tenantDataCenter",
    "auth_type": "authType",
    "login_type": "authType",
}
_SECRET = re.compile(r"(secret|password|passwd|token|key|certificate|cert_|private)", re.I)
# Splunk Add-on for Microsoft Cloud Services: account_class_type values.
_MSCS_CLASS = {"1": "Azure Public Cloud", "2": "Azure Government", "3": "Azure China"}


def microsoft_input(kind: str, app: str | None, c: dict[str, Any]) -> dict[str, Any] | None:
    """A Microsoft add-on input: the add-on, the service it reads, the account it uses,
    and the values of settings that only name things."""
    if app not in ADD_ONS and not _KINDS.match(kind):
        return None
    low = kind.lower()
    service = next((label for key, label in SERVICES if key in low), None)
    account = next((str(c[k]) for k in ACCOUNT_SETTINGS if c.get(k)), None)
    names = {k: c[k] for k in NAMING_SETTINGS if c.get(k) not in (None, "")}
    return {
        "addOn": ADD_ONS[app][0] if app in ADD_ONS else None,
        "service": service,
        "account": account,
        **({"settings": names} if names else {}),
    }


def account_properties(app: str, c: dict[str, Any]) -> dict[str, Any]:
    props: dict[str, Any] = {"addOn": ADD_ONS[app][0], "accountKind": ADD_ONS[app][2]}
    for key, prop in ACCOUNT_KEEP.items():
        v = c.get(key)
        if v in (None, "") or prop in props:
            continue
        if key == "username" and app != "TA-MS-AAD":
            continue
        if key == "account_class_type":
            v = _MSCS_CLASS.get(str(v), v)
        props[prop] = v
    return {k: v for k, v in props.items() if not _SECRET.search(k)}


def extract_microsoft_accounts(ctx: Ctx, out: ExtractResult) -> int:
    """The accounts and tenants configured in the Microsoft add-ons installed here."""
    n, found = 0, False
    for app, (_, endpoint, _kind) in ADD_ONS.items():
        try:
            entries = list(iter_entries(ctx.transport, f"/servicesNS/nobody/{app}/{endpoint}"))
        except (EndpointNotFound, EndpointForbidden):
            continue  # add-on not installed, or not visible to this account
        found = True
        for e in entries:
            if e["name"] == "default":
                continue
            add_ko(
                ctx,
                out,
                "addOnAccount",
                {
                    **e,
                    "acl": {**(e.get("acl") or {}), "app": (e.get("acl") or {}).get("app") or app},
                },
                properties=account_properties(app, content(e)),
            )
            n += 1
    if not found:
        raise EndpointNotFound("no Microsoft add-on (Cloud Services, Office 365, Azure, Security)")
    return n
