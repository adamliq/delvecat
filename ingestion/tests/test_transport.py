import pytest

from delvecat_ingest.transport import (
    EndpointNotFound,
    FixtureTransport,
    WriteAttemptError,
    check_read_only,
)


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/servicesNS/-/-/saved/searches"),
        ("HEAD", "/services/server/info"),
        ("POST", "/services/search/jobs"),
        ("POST", "/servicesNS/admin/search/search/v2/jobs"),
        ("POST", "/services/search/parser"),
    ],
)
def test_read_only_allows(method, path):
    check_read_only(method, path)


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/servicesNS/nobody/search/saved/searches"),
        ("POST", "/services/search/jobs/1234/control"),
        ("DELETE", "/services/data/indexes/main"),
        ("PUT", "/services/apps/local/search"),
        ("PATCH", "/services/search/jobs"),
    ],
)
def test_read_only_refuses(method, path):
    with pytest.raises(WriteAttemptError):
        check_read_only(method, path)


def test_fixture_transport_missing_endpoint(tmp_path):
    with pytest.raises(EndpointNotFound):
        FixtureTransport(tmp_path).get("/services/nope")


@pytest.mark.parametrize(
    "path",
    [
        "/servicesNS/nobody/search/data/lookup-table-files/_reload",
        "/services/data/inputs/monitor/_reload?foo=1",
        "/servicesNS/nobody/search/saved/searches/x/dispatch",
        "/services/server/control/restart",
    ],
)
def test_read_only_refuses_side_effecting_gets(path):
    with pytest.raises(WriteAttemptError):
        check_read_only("GET", path)


def test_reload_like_names_are_not_blocked():
    check_read_only("GET", "/servicesNS/-/-/saved/searches/enabled_reports")


# --- HttpTransport against a mocked HTTP layer ---------------------------------

import httpx  # noqa: E402

from delvecat_ingest.transport import (  # noqa: E402
    EndpointForbidden,
    HttpTransport,
    RecordingTransport,
    SearchError,
)


def _http(handler):
    return HttpTransport(
        "https://splunk:8089", "tok", backoff=0, http_transport=httpx.MockTransport(handler)
    )


def test_http_sends_bearer_and_json_mode():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["params"] = dict(req.url.params)
        return httpx.Response(200, json={"entry": []})

    _http(handler).get("/services/apps/local", {"count": 5})
    assert seen == {"auth": "Bearer tok", "params": {"count": "5", "output_mode": "json"}}


def test_http_maps_status_codes():
    t404 = _http(lambda r: httpx.Response(404))
    t403 = _http(lambda r: httpx.Response(403))
    with pytest.raises(EndpointNotFound):
        t404.get("/services/x")
    with pytest.raises(EndpointForbidden):
        t403.get("/services/x")


def test_http_retries_transient_errors():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(503 if len(calls) < 3 else 200, json={"ok": True})

    assert _http(handler).get("/services/x") == {"ok": True}
    assert len(calls) == 3


def test_http_search_uses_oneshot_and_raises_on_fatal_messages():
    def handler(req):
        body = dict(httpx.QueryParams(req.content.decode()))
        assert req.method == "POST" and req.url.path == "/services/search/jobs"
        assert body["exec_mode"] == "oneshot" and body["search"].startswith("| tstats")
        if "bad" in body["search"]:
            return httpx.Response(200, json={"messages": [{"type": "FATAL", "text": "nope"}]})
        return httpx.Response(200, json={"results": [{"a": "1"}]})

    t = _http(handler)
    assert t.search("ok", "| tstats count") == [{"a": "1"}]
    with pytest.raises(SearchError, match="nope"):
        t.search("bad", "| tstats bad")


def test_http_search_prefixes_plain_queries():
    def handler(req):
        assert dict(httpx.QueryParams(req.content.decode()))["search"] == "search index=x"
        return httpx.Response(200, json={"results": []})

    _http(handler).search("q", "index=x")
    _http(handler).search("q", "search index=x")  # never doubled


def test_recording_combines_pages_and_redacts(tmp_path):
    pages = [
        {
            "entry": [{"name": "a", "content": {"password": "p", "v": 1}}],
            "paging": {"total": 2, "offset": 0},
        },
        {"entry": [{"name": "b", "content": {"v": 2}}], "paging": {"total": 2, "offset": 1}},
    ]

    class Paged:
        def get(self, path, params=None):
            return pages[params["offset"]]

        def search(self, name, spl, earliest="-24h", latest="now"):
            return [{"x": 1}]

    rec = RecordingTransport(Paged(), tmp_path)
    rec.get("/services/things", {"offset": 0})
    rec.get("/services/things", {"offset": 1})
    rec.search("q1", "| tstats count")
    replay = FixtureTransport(tmp_path)
    body = replay.get("/services/things")
    assert [e["name"] for e in body["entry"]] == ["a", "b"]
    assert "password" not in json.dumps(body)
    assert replay.search("q1", "ignored") == [{"x": 1}]


import json  # noqa: E402
