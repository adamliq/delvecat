"""Connection test to another stack: each step and what it says when it fails."""

from __future__ import annotations

import socket

import pytest

from delvecat_ingest.connectivity import check_stack, parse_target


def test_address_rules():
    t = parse_target("sh.example.com")
    assert (t.host, t.port) == ("sh.example.com", 8089)
    assert str(parse_target("https://sh.example.com:9089/")) == "sh.example.com:9089"
    for bad, why in [
        ("http://sh:8089", "https"),
        ("https://user:pw@sh:8089", "credentials"),
        ("https://sh:8089/services", "only the address"),
        ("https://sh:port", "not a number"),
    ]:
        with pytest.raises(ValueError, match=why):
            parse_target(bad)
    r = check_stack("http://sh:8089", None)
    assert not r["ok"] and r["steps"][0]["step"] == "address"


def _getter(answers):
    seen = []

    def get(path):
        seen.append(path)
        for prefix, answer in answers.items():
            if path.startswith(prefix):
                return answer
        return 404, None

    return get, seen


INFO = (200, {"entry": [{"content": {"serverName": "sh2", "version": "10.4.5"}}]})
APP = (200, {"entry": [{"content": {"version": "0.21.0", "disabled": False}}]})
POINTER = (
    200,
    {
        "generatedAt": "2026-11-21T10:00:00Z",
        "publishedAt": "2026-11-21T10:01:00Z",
        "entities": 8649,
    },
)


def test_all_good():
    kv = "/servicesNS/nobody/delvecat/storage/collections/data/delvecat_catalog/current"
    get, seen = _getter(
        {"/services/server/info": INFO, "/services/apps/local/delvecat": APP, kv: POINTER}
    )
    r = check_stack("https://sh2:8089", "tok", local_version="0.21.0", get=get)
    assert r["ok"] and r["target"] == "sh2:8089"
    by = {s["step"]: s for s in r["steps"]}
    assert by["auth"]["status"] == "ok" and "sh2: Splunk 10.4.5" in by["auth"]["message"]
    assert by["app"]["status"] == "ok" and by["app"]["version"] == "0.21.0"
    assert by["catalog"]["entities"] == 8649 and "8,649 objects" in by["catalog"]["message"]
    assert all("tok" not in str(s) for s in r["steps"])  # the token is never returned
    assert all(p.startswith(("/services/", "/servicesNS/nobody/delvecat/")) for p in seen)


def test_refused_token_stops_there():
    get, _ = _getter({"/services/server/info": (401, None)})
    r = check_stack("https://sh2:8089", "bad", get=get)
    assert not r["ok"]
    assert r["steps"][-1]["step"] == "auth" and "refused" in r["steps"][-1]["message"]


def test_app_missing_disabled_or_another_version():
    get, _ = _getter({"/services/server/info": INFO})
    r = check_stack("https://sh2:8089", "t", get=get)
    assert not r["ok"] and "not installed" in r["steps"][-1]["message"]
    get, _ = _getter(
        {
            "/services/server/info": INFO,
            "/services/apps/local/delvecat": (
                200,
                {"entry": [{"content": {"version": "0.21.0", "disabled": True}}]},
            ),
        }
    )
    assert "disabled" in check_stack("https://sh2:8089", "t", get=get)["steps"][-1]["message"]
    get, _ = _getter({"/services/server/info": INFO, "/services/apps/local/delvecat": APP})
    r = check_stack("https://sh2:8089", "t", local_version="0.20.1", get=get)
    app = next(s for s in r["steps"] if s["step"] == "app")
    assert app["status"] == "warning" and "0.20.1" in app["message"]
    # No catalog yet: reachable, with a warning.
    assert r["ok"] and r["steps"][-1]["status"] == "warning"


def test_without_a_token_only_the_network_is_checked():
    get, seen = _getter({})
    r = check_stack("https://sh2:8089", None, get=get)
    assert r["ok"] and not seen
    assert [s["status"] for s in r["steps"]] == ["skipped", "skipped", "skipped"]


def test_name_that_does_not_resolve():
    r = check_stack("https://no-such-host.invalid:8089", "t", timeout=3)
    assert not r["ok"] and r["steps"][0]["step"] == "dns" and r["steps"][0]["status"] == "failed"


def test_port_that_refuses():
    with socket.socket() as s:  # a free port nothing listens on
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    r = check_stack(f"https://127.0.0.1:{port}", "t", timeout=3)
    tcp = next(x for x in r["steps"] if x["step"] == "tcp")
    assert tcp["status"] == "failed" and "refused" in tcp["message"]
