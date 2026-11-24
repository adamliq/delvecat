"""Lookup fields: read from file headers, shared between a definition and its file or
KV Store collection, and added to sourcetypes by automatic lookups."""

from __future__ import annotations

import copy
from pathlib import Path

import httpx

from delvecat_ingest.connectors.splunk.common import Ctx, Options
from delvecat_ingest.connectors.splunk.knowledge import extract_lookup_files
from delvecat_ingest.fields import define_fields, fill_lookup_fields, lookup_columns
from delvecat_ingest.inapp import build_here
from delvecat_ingest.model import ExtractResult
from delvecat_ingest.transport import FixtureTransport, HttpTransport, SearchError

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
FILES = "/servicesNS/-/-/data/lookup-table-files"


class Spy(FixtureTransport):
    """Records which apps lookup headers were read in; can fail or alter the file list."""

    def __init__(self, fail=False, private=False):
        super().__init__(FIXTURE)
        self.calls: list[tuple[str, str]] = []
        self.fail, self.private = fail, private

    def get(self, path, params=None):
        body = super().get(path, params)
        if self.private and path == FILES:
            body = copy.deepcopy(body)
            for e in body["entry"]:
                e["acl"]["sharing"] = "user"
        return body

    def search_in_app(self, app, name, spl, earliest="-24h", latest="now"):
        self.calls.append((app, name))
        if self.fail:
            raise SearchError("The lookup table could not be read")
        return super().search_in_app(app, name, spl, earliest, latest)


def _files(transport, **options):
    out = ExtractResult()
    extract_lookup_files(Ctx(transport, "acme", Options(**options)), out)
    return {e["name"]: e for e in out.entities}


def test_header_read_only_for_files_no_definition_describes():
    spy = Spy()
    files = _files(spy)
    p = files["web_status_codes.csv"]["properties"]
    assert p["fields"] == ["status", "meaning", "category"] and p["fieldsFrom"] == "header"
    # Read in the file's own app; files with a definition (and .kmz) are not searched.
    assert spy.calls == [("acme_web", "lookup_header/acme_web/web_status_codes.csv")]
    assert "fields" not in files["asset_owners.csv"].get("properties", {})


def test_header_reading_can_be_turned_off_and_skips_failures_and_private_files():
    spy = Spy()
    assert "fields" not in _files(spy, lookup_headers=0)["web_status_codes.csv"]["properties"]
    assert spy.calls == []
    assert "fields" not in _files(Spy(fail=True))["web_status_codes.csv"]["properties"]
    spy = Spy(private=True)
    _files(spy)
    assert spy.calls == []


def test_definitions_and_files_share_fields():
    def_ = {"id": "i:lookup:a/owners", "type": "lookup", "name": "owners", "instance": "i",
            "properties": {"kind": "csv", "filename": "owners.csv"}}  # fmt: skip
    header = {"kind": "file", "fields": ["ip", "owner"], "fieldsFrom": "header"}
    file = {"id": "i:lookup:a/owners.csv", "type": "lookup", "name": "owners.csv", "instance": "i",
            "properties": header}  # fmt: skip
    kv_def = {"id": "i:lookup:a/threats", "type": "lookup", "name": "threats", "instance": "i",
              "properties": {"kind": "kvstore", "collection": "threats"}}  # fmt: skip
    typed = {"fields": {"ip": "string", "score": "number"}}
    kv = {"id": "i:kvCollection:a/threats", "type": "kvCollection", "name": "threats",
          "instance": "i", "properties": typed}  # fmt: skip
    assert fill_lookup_fields([def_, file, kv_def, kv]) == 2
    assert def_["properties"]["fields"] == ["ip", "owner"]
    assert def_["properties"]["fieldsFrom"] == file["id"]
    assert lookup_columns(kv_def) == ["ip", "score"] and lookup_columns(kv) == ["ip", "score"]


def test_built_catalog_has_fields_on_files_from_their_definitions():
    by_name = {
        e["name"]: e
        for e in build_here(FixtureTransport(FIXTURE), "acme")["entities"]
        if e["type"] == "lookup"
    }
    f = by_name["asset_owners.csv"]["properties"]
    assert f["fields"] == ["ip", "owner"] and f["fieldsFrom"].endswith("/asset_owners")
    assert by_name["web_status_codes.csv"]["properties"]["fieldsFrom"] == "header"


def test_automatic_lookup_without_outputs_adds_every_other_field():
    st = {"id": "i:sourcetype:fw", "type": "sourcetype", "name": "fw", "instance": "i"}
    lk = {"id": "i:lookup:a/owners", "type": "lookup", "name": "owners", "instance": "i",
          "properties": {"kind": "csv", "fields": ["ip", "owner", "dept", "_key"]}}  # fmt: skip
    auto = {"id": "i:automaticLookup:a/fw : LOOKUP-o", "type": "automaticLookup",
            "name": "fw : LOOKUP-o", "instance": "i",
            "properties": {"stanza": "fw", "lookup": "owners", "inputFields": {"ip": "src_ip"},
                           "outputFields": {}}}  # fmt: skip
    entities = [st, lk, auto]
    edges = define_fields(entities)
    defined = {x["to"] for x in edges if x["type"] == "definesField"}
    assert defined == {"i:field:fw/owner", "i:field:fw/dept"}
    assert {"from": auto["id"], "to": "i:field:fw/src_ip", "type": "readsField",
            "origin": "config"} in edges  # fmt: skip


def test_http_search_in_app_runs_in_the_apps_context():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.raw_path.decode())
        return httpx.Response(200, json={"results": [{"field": "status"}]})

    t = HttpTransport("https://splunk:8089", "tok", http_transport=httpx.MockTransport(handler))
    assert t.search_in_app("acme web", "h", '| inputlookup "x.csv"') == [{"field": "status"}]
    assert seen == ["/servicesNS/-/acme%20web/search/jobs"]


def test_header_reads_stop_at_the_time_limit():
    import time

    class Slow(Spy):
        def search_in_app(self, app, name, spl, earliest="-24h", latest="now"):
            time.sleep(1.5)
            return super().search_in_app(app, name, spl, earliest, latest)

    started = time.monotonic()
    files = _files(Slow(), lookup_header_seconds=0.2)
    assert time.monotonic() - started < 1.0  # did not wait for the slow search
    assert "fields" not in files["web_status_codes.csv"]["properties"]
