"""Email alert actions: who alerts write to, and how redaction profiles treat them."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from delvecat_ingest.connectors.splunk.knowledge import email_recipients
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
ALERT = "acme:savedSearch:acme_secops/Firewall - Denied Outbound to Rare Ports"


@pytest.fixture(scope="module")
def bundle():
    return build_here(FixtureTransport(FIXTURE), "acme")


def _props(bundle, eid=ALERT):
    return next(e for e in bundle["entities"] if e["id"] == eid)["properties"]


def test_recipients_parsed():
    assert email_recipients(
        {
            "actions": "email,script",
            "action.email.to": "a@x.example, b@x.example;a@x.example  <c@y.example>",
            "action.email.bcc": "$result.owner$",
            "action.email.from": "splunk@x.example",
            "action.email.cc": "",
        }
    ) == {
        "to": ["a@x.example", "b@x.example", "c@y.example"],
        "bcc": ["$result.owner$"],
        "from": "splunk@x.example",
    }
    assert email_recipients({"actions": "script", "action.email.to": "a@x.example"}) is None
    assert email_recipients({"actions": "", "action.email": "1"}) is None  # nothing configured


def test_alert_carries_its_recipients(bundle):
    assert _props(bundle)["alertRecipients"] == {
        "to": ["secops-oncall@acme.example", "jane.doe@acme.example"],
        "cc": ["$result.owner$"],
        "from": "splunk-alerts@acme.example",
    }
    # Only searches with the email action get them.
    searches = [e for e in bundle["entities"] if e["type"] == "savedSearch" and e["id"] != ALERT]
    assert not [e for e in searches if e["properties"].get("alertRecipients")]


def test_internal_keeps_domains_public_drops(bundle):
    internal = copy.deepcopy(bundle)
    counts = redact_bundle(internal, load_profile("internal"))
    assert _props(internal)["alertRecipients"] == {
        "to": ["*@acme.example"],
        "cc": ["$result.owner$"],
        "from": "*@acme.example",
    }
    assert counts["emails"] == 4 + 3  # the alert, plus the scheduled view's three
    public = copy.deepcopy(bundle)
    redact_bundle(public, load_profile("public"), salt="t")
    assert "alertRecipients" not in _props(public)
    assert "acme.example" not in json.dumps(public)


def test_email_action_default_sender():
    class WithEmailAction(FixtureTransport):
        def get(self, path, params=None):
            body = super().get(path, params)
            if path.endswith("alerts/alert_actions"):
                body = copy.deepcopy(body)
                body["entry"].append(
                    {
                        "name": "email",
                        "acl": {"app": "search", "owner": "nobody", "sharing": "global"},
                        "content": {
                            "label": "Send email",
                            "from": "splunk@acme.example",
                            "to": "",
                            "bcc": "audit@acme.example",
                        },
                    }
                )
            return body

    b = build_here(WithEmailAction(FIXTURE), "acme")
    action = next(
        e for e in b["entities"] if e["type"] == "adaptiveResponseAction" and e["name"] == "email"
    )
    assert action["properties"]["sender"] == "splunk@acme.example"
    assert action["properties"]["defaultRecipients"] == {"bcc": ["audit@acme.example"]}
    keep = copy.deepcopy(b)
    redact_bundle(keep, load_profile("internal"))
    action = next(
        e
        for e in keep["entities"]
        if e["type"] == "adaptiveResponseAction" and e["name"] == "email"
    )
    assert action["properties"]["sender"] == "*@acme.example"
    assert action["properties"]["defaultRecipients"] == {"bcc": ["*@acme.example"]}


def test_bare_default_sender_is_kept():
    from delvecat_ingest.redaction import _redact_emails

    props = {"sender": "splunk"}  # Splunk adds its host name when it sends
    _redact_emails(props, "domain")
    assert props == {"sender": "splunk"}
