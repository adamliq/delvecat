"""Modular inputs (add-on inputs) and SAML/LDAP group-to-role mappings."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


@pytest.fixture(scope="module")
def bundle():
    return build_here(FixtureTransport(FIXTURE), "acme")


def _by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def _edges(bundle, src, type_):
    return {x["to"] for x in bundle["edges"] if x["from"] == src and x["type"] == type_}


def test_modular_input_feeds_its_index_and_hides_its_settings(bundle):
    by_id = _by_id(bundle)
    eid = "acme:input:Splunk_TA_aws/aws_cloudtrail://acme_prod_trail"
    ent = by_id[eid]
    p = ent["properties"]
    assert p["kind"] == "aws_cloudtrail" and p["modular"] is True
    assert p["modularInputTitle"] == "AWS CloudTrail"
    assert p["index"] == "main" and p["sourcetype"] == "aws:cloudtrail"
    # Its own settings by name only: values may be accounts, queues or keys.
    assert p["settingNames"] == [
        "aws_account",
        "aws_region",
        "remove_files_when_done",
        "secret_key",
        "sqs_queue",
    ]
    text = json.dumps(bundle)
    for value in ("should-never-appear", "acme-prod", "acme-cloudtrail-queue", "eu-west-1"):
        assert value not in text
    # Feeds the index it names (a sourcetype gets an edge once it is in the catalog).
    assert "acme:index:main" in _edges(bundle, eid, "feeds")


def test_disabled_modular_input_feeds_nothing(bundle):
    eid = "acme:input:journald_input/journald://default"
    assert _by_id(bundle)[eid]["disabled"] is True
    assert not _edges(bundle, eid, "feeds")


def test_identity_groups_grant_roles_and_keep_no_members(bundle):
    by_id = _by_id(bundle)
    groups = {e["id"]: e for e in bundle["entities"] if e["type"] == "authGroup"}
    assert set(groups) == {
        "acme:authGroup:saml:acme-soc-analysts",
        "acme:authGroup:saml:acme-splunk-admins",
        "acme:authGroup:ldap:acme_ad:legacy-ops",
    }
    soc = groups["acme:authGroup:saml:acme-soc-analysts"]
    assert soc["displayName"] == "acme-soc-analysts" and soc["properties"]["provider"] == "SAML"
    assert _edges(bundle, soc["id"], "memberOf") == {"acme:role:user", "acme:role:acme_soc"}
    ldap = groups["acme:authGroup:ldap:acme_ad:legacy-ops"]
    assert ldap["properties"]["strategy"] == "acme_ad" and ldap["properties"]["memberCount"] == 2
    assert _edges(bundle, ldap["id"], "memberOf") == {"acme:role:power"}
    text = json.dumps(bundle)
    for secret in ("Jane Doe", "CN=Sam Lee", "svc-splunk", "ad.acme.example", "********"):
        assert secret not in text
    assert all(r in by_id for g in groups.values() for r in _edges(bundle, g["id"], "memberOf"))


def test_instance_records_how_people_log_in(bundle):
    auth = bundle["instances"][0]["properties"]["authentication"]
    assert auth == {
        "type": "SAML",
        "providers": ["acme_okta"],
        "ldapStrategies": [{"name": "acme_ad", "ssl": True, "disabled": False}],
    }


def test_groups_are_not_counted_as_users(bundle):
    groups = {e["id"] for e in bundle["entities"] if e["type"] == "authGroup"}
    for e in bundle["entities"]:
        gov = json.dumps(e.get("governance") or {})
        assert not any(g in gov for g in groups), e["id"]
