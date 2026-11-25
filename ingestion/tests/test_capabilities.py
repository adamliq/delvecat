"""Capabilities: objects for what roles may do, high-risk ones marked, roles linked to
the capabilities they grant, and custom roles granting high-risk ones flagged."""

from __future__ import annotations

import copy
from pathlib import Path

from delvecat_ingest.inapp import build_here, resolve_parts
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
ROLES = "/services/authorization/roles"


class RiskyRole(FixtureTransport):
    def get(self, path, params=None):
        body = super().get(path, params)
        if path == ROLES:
            body = copy.deepcopy(body)
            for e in body["entry"]:
                if e["name"] == "acme_soc":
                    e["content"]["capabilities"] = [
                        *e["content"].get("capabilities", []),
                        "edit_user",
                    ]
        return body


def _caps(bundle):
    return {e["name"]: e for e in bundle["entities"] if e["type"] == "capability"}


def test_capabilities_are_objects_with_risk_and_where_defined():
    bundle = build_here(FixtureTransport(FIXTURE), "acme")
    caps = _caps(bundle)
    assert len(caps) > 100
    assert caps["admin_all_objects"]["properties"]["risk"] == "high"
    assert "every knowledge object" in caps["admin_all_objects"]["description"]
    assert "risk" not in caps["schedule_search"].get("properties", {})
    custom = caps["acme_run_playbook"]
    assert custom["app"] == "acme_secops" and "builtin" not in custom.get("properties", {})


def test_roles_are_linked_to_the_capabilities_they_grant():
    bundle = build_here(FixtureTransport(FIXTURE), "acme")
    grants = {(x["from"], x["to"]) for x in bundle["edges"] if x["type"] == "grantsAccess"}
    assert ("acme:role:admin", "acme:capability:admin_all_objects") in grants
    assert ("acme:role:can_delete", "acme:capability:delete_by_keyword") in grants


def test_custom_roles_granting_high_risk_capabilities_are_flagged():
    bundle = build_here(RiskyRole(FIXTURE), "acme")
    by_id = {e["id"]: e for e in bundle["entities"]}
    checks = {c["check"]: c for c in by_id["acme:role:acme_soc"]["health"]["checks"]}
    assert "edit_user" in checks["riskyCapability"]["message"]
    admin = (by_id["acme:role:admin"].get("health") or {}).get("checks", [])
    assert not any(c["check"] == "riskyCapability" for c in admin)  # Splunk's own role


def test_the_capabilities_part_needs_roles():
    assert "roles" in resolve_parts({"capabilities"})
