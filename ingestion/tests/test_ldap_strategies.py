"""LDAP strategies and group → role mappings, from authentication.conf, with or without
the LDAP server answering."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from delvecat_ingest.bundle import assemble
from delvecat_ingest.connectors.splunk import access
from delvecat_ingest.connectors.splunk.common import Ctx
from delvecat_ingest.model import ExtractResult
from delvecat_ingest.transport import EndpointNotFound

NOW = datetime(2026, 11, 26, 2, 0, tzinfo=timezone.utc)
CONF = "/servicesNS/nobody/system/configs/conf-authentication"
SECRETS = ("cn=svc,ou=svc,dc=corp", "Bind-Pass-1!", "ou=people", "ldap1.corp.example", "uid=jane")

AUTH = [
    ("authentication", {"authType": "LDAP", "authSettings": "corp_ldap,backup_ldap"}),
    (
        "corp_ldap",
        {
            "host": "ldap1.corp.example",
            "port": "636",
            "SSLEnabled": "1",
            "sslVerifyServerCert": "1",
            "bindDN": "cn=svc,ou=svc,dc=corp",
            "bindDNpassword": "Bind-Pass-1!",
            "userBaseDN": "ou=people,dc=corp",
            "groupBaseDN": "ou=groups,dc=corp",
            "userBaseFilter": "(objectClass=person)",
            "userNameAttribute": "uid",
            "groupNameAttribute": "cn",
            "groupMemberAttribute": "member",
            "nestedGroups": "1",
            "sizelimit": "1000",
        },
    ),
    (
        "backup_ldap",
        {
            "host": "ldap2.corp.example",
            "port": "389",
            "SSLEnabled": "0",
            "userBaseDN": "ou=people,dc=corp",
            "userNameAttribute": "uid",
        },
    ),
    (
        "old_ldap",
        {
            "host": "ldap0",
            "userBaseDN": "ou=people,dc=corp",
            "userNameAttribute": "uid",
            "disabled": "1",
        },
    ),
    (
        "roleMap_corp_ldap",
        {"admin": "splunk-admins", "user": "soc;helpdesk", "ghost_role": "soc", "disabled": "0"},
    ),
    ("roleMap_SAML", {"user": "okta-analysts"}),
    ("splunk_auth", {"minPasswordLength": "8"}),
]
GROUPS = [
    (
        "splunk-admins",
        {
            "roles": ["admin"],
            "strategy": "corp_ldap",
            "type": "static",
            "users": ["uid=jane,ou=people,dc=corp"],
        },
    ),
    (
        "soc",
        {
            "roles": ["user", "ghost_role"],
            "strategy": "corp_ldap",
            "type": "nested",
            "users": ["a", "b", "c"],
        },
    ),
]


class Mem:
    def __init__(self, ldap_up=True):
        self.ldap_up = ldap_up

    def get(self, path, params=None):
        routes = {CONF: AUTH, "/services/authorization/roles": [("admin", {}), ("user", {})]}
        if path == "/services/admin/LDAP-groups":
            if not self.ldap_up:
                raise RuntimeError("500 Server Error: please check your LDAP configuration")
            return _body(GROUPS)
        if path not in routes:
            raise EndpointNotFound(path)
        return _body(routes[path])


def _body(rows):
    return {"entry": [{"name": n, "content": c, "acl": {}} for n, c in rows]}


def build(ldap_up=True):
    t, out = Mem(ldap_up), ExtractResult()
    ctx = Ctx(t, "sh")
    access.extract_roles(ctx, out)
    result = access.extract_auth_groups(ctx, out)
    inst = {
        "id": "sh",
        "name": "sh",
        "kind": "splunkEnterprise",
        "properties": out.instance_facts.get("properties", {}),
    }
    b = assemble([inst], out, NOW)
    return {e["name"]: e for e in b["entities"] if e["type"].startswith("auth")}, b, result


def checks(e):
    return {c["check"]: c["message"] for c in (e.get("health") or {}).get("checks", [])}


def test_strategies_are_objects_without_secrets():
    ents, b, _ = build()
    corp = ents["corp_ldap"]["properties"]
    assert (corp["active"], corp["order"], corp["port"], corp["ssl"], corp["verifyServerCert"]) == (
        True,
        1,
        636,
        True,
        True,
    )
    assert corp["nestedGroups"] and corp["userFilter"] and corp["sizeLimit"] == 1000
    assert ents["backup_ldap"]["properties"]["order"] == 2
    assert ents["old_ldap"]["disabled"] and not ents["old_ldap"]["properties"]["active"]
    assert "splunk_auth" not in ents and "roleMap_corp_ldap" not in ents
    text = json.dumps(b)
    assert not [s for s in SECRETS if s in text]


def test_mappings_come_from_conf_and_are_enriched_by_ldap():
    ents, b, result = build()
    assert result == 4
    soc = ents["ldap:corp_ldap:soc"]["properties"]
    assert soc["roles"] == ["ghost_role", "user"] and soc["memberCount"] == 3
    assert soc["groupType"] == "nested" and soc["foundInDirectory"] is True
    assert ents["ldap:corp_ldap:helpdesk"]["properties"]["foundInDirectory"] is False
    assert ents["saml:okta-analysts"]["properties"]["roles"] == ["user"]
    contains = {x["to"] for x in b["edges"] if x["from"] == "sh:authStrategy:corp_ldap"}
    assert contains == {
        "sh:authGroup:ldap:corp_ldap:soc",
        "sh:authGroup:ldap:corp_ldap:helpdesk",
        "sh:authGroup:ldap:corp_ldap:splunk-admins",
    }


def test_mappings_survive_an_unreachable_ldap_server():
    ents, _, result = build(ldap_up=False)
    count, message = result
    assert count == 4 and "not reachable" in message
    soc = ents["ldap:corp_ldap:soc"]["properties"]
    assert soc["roles"] == ["ghost_role", "user"] and "memberCount" not in soc
    assert "foundInDirectory" not in soc  # unknown: nothing to warn about
    assert "authGroupNotFound" not in checks(ents["ldap:corp_ldap:helpdesk"])


def test_checks():
    ents, _, _ = build()
    assert checks(ents["backup_ldap"])["ldapTls"].startswith("Talks to LDAP without SSL")
    assert "ldapTls" not in checks(ents["corp_ldap"])
    assert "health" not in ents["old_ldap"]  # disabled
    assert checks(ents["ldap:corp_ldap:soc"])["authGroupRole"] == (
        "Mapped to roles that do not exist: ghost_role"
    )
    assert (
        "Not found in LDAP strategy corp_ldap"
        in checks(ents["ldap:corp_ldap:helpdesk"])["authGroupNotFound"]
    )
