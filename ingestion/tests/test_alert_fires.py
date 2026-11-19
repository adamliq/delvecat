"""Fired alerts: how often each alert actually triggers, not just runs."""

from __future__ import annotations

from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
FIREWALL = "acme:savedSearch:acme_secops/Firewall - Denied Outbound to Rare Ports"
BRUTE = "acme:correlationSearch:DA-ESS-ContentUpdate/ESCU - Brute Force Access Behavior Detected"
RARE = "acme:correlationSearch:DA-ESS-ContentUpdate/ESCU - Rare Outbound Port Traffic"
SUMMARY = "acme:savedSearch:acme_web/Web - Hourly Status Summary"


class Rows(FixtureTransport):
    def __init__(self, rows):
        super().__init__(FIXTURE)
        self.rows = rows

    def search(self, name, spl, earliest="-24h", latest="now"):
        if name == "usage_alert_fires":
            return self.rows
        return super().search(name, spl, earliest, latest)


def _build(transport=None, parts=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme", parts=parts)
    return {e["id"]: e for e in bundle["entities"]}


def _checks(e):
    return {c["check"]: c for c in (e.get("health") or {}).get("checks", [])}


def test_fires_suppressed_and_last_fired():
    by_id = _build()
    u = by_id[FIREWALL]["usage"]
    assert u["alertFires"] == 3 and u["alertsSuppressed"] == 12
    assert u["lastFired"].startswith("2026-") and u["alertWindow"] == "-30d"
    assert "alertNoisy" not in _checks(by_id[FIREWALL])


def test_alert_that_never_fired_reads_zero():
    u = _build()[RARE]["usage"]
    assert u["alertFires"] == 0 and u["alertWindow"] == "-30d"
    # Without the part, nothing is known: no zero.
    by_id = _build(parts={"savedSearches", "usageSavedSearches"})
    assert "alertFires" not in (by_id[RARE].get("usage") or {})


def test_noisy_alert_is_flagged_but_reports_are_not():
    by_id = _build()
    msg = _checks(by_id[BRUTE])["alertNoisy"]["message"]
    assert "Fired 1,500 times in the last 30 days (about 50 a day)" in msg
    # A report that writes a summary every run is not an alert: counted, never "noisy".
    assert by_id[SUMMARY]["usage"]["alertFires"] == 720
    assert "alertNoisy" not in _checks(by_id[SUMMARY])


def test_audit_and_scheduler_records_are_not_double_counted():
    rows = [
        {
            "ssApp": "acme_secops",
            "name": "Firewall - Denied Outbound to Rare Ports",
            "schedFired": "5",  # with email actions
            "auditFired": "7",  # tracked: also the firings that sent nothing
            "suppressed": "0",
            "last": "1793900000",
        }
    ]
    assert _build(Rows(rows))[FIREWALL]["usage"]["alertFires"] == 7
