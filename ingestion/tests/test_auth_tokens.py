"""Authentication tokens: metadata only, and the checks for stale, expired and orphaned ones."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def _tid(user: str, audience: str) -> str:
    return "acme:authToken:" + hashlib.sha256(f"{user}{audience}".encode()).hexdigest()


CI = _tid("admin", "CI pipeline")
GRAFANA = _tid("jlee", "Grafana")
OLD = _tid("mpatel", "Old report script")
LEAVER = _tid("rsmith", "Leaver sync job")
BREAK_GLASS = _tid("admin", "Break-glass")
RETIRED = _tid("jlee", "Retired dashboard")


def _build(parts=None):
    bundle = build_here(FixtureTransport(FIXTURE), "acme", parts=parts)
    return bundle, {e["id"]: e for e in bundle["entities"]}


def _checks(e):
    return {c["check"]: c for c in (e.get("health") or {}).get("checks", [])}


def test_metadata_only():
    bundle, by_id = _build()
    t = by_id[CI]
    assert t["type"] == "authToken" and t["owner"] == "admin"
    assert t["displayName"].startswith("CI pipeline (")
    p = t["properties"]
    assert p["user"] == "admin" and p["audience"] == "CI pipeline" and p["issuedBy"] == "admin"
    assert p["expiresAt"].startswith("2027-") and p["lastUsed"].startswith("2026-11-05")
    assert p.get("restrictedRoles") is None
    text = json.dumps(bundle)
    assert "10.1.2.3" not in text  # the last client address is not kept
    assert "HS512" not in text  # nor anything from the token's header
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    assert ("acme:user:admin", CI, "contains") in edges
    assert not _checks(t)


def test_expiring_expired_never_expiring_and_stale():
    _, by_id = _build()
    assert "Expires in 5.0 days" in _checks(by_id[GRAFANA])["tokenExpiring"]["message"]
    old = _checks(by_id[OLD])
    assert "Expired 10.0 days ago" in old["tokenExpired"]["message"]
    assert "tokenStale" not in old  # an expired token is reported as expired, once
    assert "tokenNoExpiry" in _checks(by_id[BREAK_GLASS])
    assert "tokenStale" not in _checks(by_id[BREAK_GLASS])  # new, so not stale yet
    assert "Not used for 120.0 days" in _checks(by_id[LEAVER])["tokenStale"]["message"]


def test_token_of_a_user_splunk_no_longer_has():
    _, by_id = _build()
    leaver = by_id[LEAVER]
    assert leaver["health"]["status"] == "critical"
    assert "user no longer exists" in _checks(leaver)["tokenNoOwner"]["message"]
    # Without the users part, nobody is judged to be missing.
    _, by_id = _build(parts={"authTokens"})
    assert "tokenNoOwner" not in _checks(by_id[LEAVER])


def test_cleanup_report_and_disabled_tokens():
    _, by_id = _build()
    assert by_id[OLD]["usage"]["unused"] is True
    assert by_id[OLD]["usage"]["reason"].startswith("Authentication token: Expired")
    assert by_id[LEAVER]["usage"]["unused"] is True
    assert not (by_id[CI].get("usage") or {}).get("unused")
    retired = by_id[RETIRED]
    assert retired["disabled"] is True and "health" not in retired


def test_public_profile_pseudonymizes_token_users():
    bundle, _ = _build()
    redact_bundle(bundle, load_profile("public"), salt="test")
    tokens = [e for e in bundle["entities"] if e["type"] == "authToken"]
    text = json.dumps(tokens)
    for name in ("jlee", "mpatel", "rsmith"):
        assert name not in text
    assert all(t["properties"]["user"].startswith("user-") for t in tokens)
