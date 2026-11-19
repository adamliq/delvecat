"""HTTP Event Collector: tokens, HEC's own on/off switch, per-token use and rejections."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import EndpointNotFound, FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
TOKEN_ID = "acme:input:splunk_httpinput/http://acme_storefront"
SECRET = "8d1f5c3e-0b6a-4c2e-9f77-d2b6a1e0c9aa"


class Patched(FixtureTransport):
    """The recorded Splunk, with some REST answers and searches replaced."""

    def __init__(self, rest: dict[str, Any] | None = None, searches: dict[str, Any] | None = None):
        super().__init__(FIXTURE)
        self.rest = rest or {}
        self.searches = searches or {}

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if path in self.rest:
            if self.rest[path] is None:
                raise EndpointNotFound(path)
            return copy.deepcopy(self.rest[path])
        return super().get(path, params)

    def search(self, name, spl, earliest="-24h", latest="now"):
        if name in self.searches:
            return self.searches[name]
        return super().search(name, spl, earliest, latest)


def _tokens_with(**changes: Any) -> dict[str, Any]:
    """The recorded HEC token list, as a live Splunk returns it (with the token value)."""
    body = json.loads((FIXTURE / "servicesNS/-/-/data/inputs/http.json").read_text())
    for e in body["entry"]:
        e["content"]["token"] = SECRET
        e["content"].update(changes)
    return body


def _global(disabled: bool) -> dict[str, Any]:
    return {
        "entry": [
            {
                "name": "http",
                "acl": {"app": "splunk_httpinput", "owner": "nobody", "sharing": "app"},
                "content": {"disabled": disabled, "port": "8088", "enableSSL": "1"},
            }
        ]
    }


def _build(transport, parts=None):
    bundle = build_here(transport, "acme", parts=parts)
    by_id = {e["id"]: e for e in bundle["entities"]}
    return bundle, by_id


def test_token_use_rejections_and_instance_counts():
    bundle, by_id = _build(FixtureTransport(FIXTURE))
    token = by_id[TOKEN_ID]
    u = token["usage"]
    assert u["hecEvents"] == 1284512 and u["hecBytes"] == 903421877
    assert u["hecRejections"] == [
        {
            "reason": "Incorrect index",
            "index": "web_debug",
            "count": 42,
            "last": u["hecRejections"][0]["last"],
        }
    ]
    assert u["lastUsed"].startswith("2026-")
    checks = {c["check"]: c for c in token["health"]["checks"]}
    assert "web_debug" in checks["hecRejected"]["message"]
    assert "42 requests rejected" in checks["hecRejected"]["message"]
    hec = bundle["instances"][0]["properties"]["httpEventCollector"]
    assert hec["invalidTokenRequests"] == 17  # counted, nothing else kept about them
    assert not u.get("unused")


def test_token_value_never_reaches_the_catalog():
    transport = Patched(rest={"/servicesNS/-/-/data/inputs/http": _tokens_with()})
    bundle, by_id = _build(transport)
    assert SECRET not in json.dumps(bundle)
    assert by_id[TOKEN_ID]["properties"]["allowedIndexes"] == ["web", "summary_web"]


def test_hec_switched_off_makes_tokens_feed_nothing():
    on = Patched(rest={"/services/data/inputs/http/http": _global(False)})
    off = Patched(rest={"/services/data/inputs/http/http": _global(True)})
    b_on, on_ids = _build(on)
    b_off, off_ids = _build(off)
    assert b_on["instances"][0]["properties"]["httpEventCollector"]["port"] == 8088

    def feeds(b):
        return {x["to"] for x in b["edges"] if x["from"] == TOKEN_ID and x["type"] == "feeds"}

    assert feeds(b_on) and not feeds(b_off)
    token = off_ids[TOKEN_ID]
    assert token["properties"]["hecEnabled"] is False
    assert token["health"]["status"] == "critical"
    assert any(c["check"] == "hecOff" for c in token["health"]["checks"])
    assert b_off["instances"][0]["properties"]["httpEventCollector"]["enabled"] is False


def test_idle_token_is_unused_only_when_measured():
    idle = Patched(searches={"usage_hec": [], "usage_hec_rejections": []})
    _, by_id = _build(idle)
    assert by_id[TOKEN_ID]["usage"]["unused"] is True
    assert "no events" in by_id[TOKEN_ID]["usage"]["reason"]
    assert not by_id[TOKEN_ID]["usage"].get("builtin")  # tokens live in Splunk's apps
    # Without the HEC usage part, nothing is known, so nothing is judged.
    parts = {"inputs", "indexes", "sourcetypes"}
    _, by_id = _build(idle, parts=parts)
    assert not (by_id[TOKEN_ID].get("usage") or {}).get("unused")


def test_disabled_token_still_receiving_requests():
    transport = Patched(
        rest={"/servicesNS/-/-/data/inputs/http": _tokens_with(disabled=True)},
        searches={
            "usage_hec": [{"token": "acme_storefront", "events": "0", "toDisabled": "250"}],
            "usage_hec_rejections": [],
        },
    )
    _, by_id = _build(transport)
    token = by_id[TOKEN_ID]
    assert token["disabled"] is True
    assert token["health"]["checks"][0]["check"] == "hecDisabledInUse"
    assert "250 requests" in token["health"]["checks"][0]["message"]
