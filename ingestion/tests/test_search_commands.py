"""Custom search commands: which app adds each one, and the searches that run them."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from delvecat_ingest.inapp import build_here
from delvecat_ingest.spl import analyze
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
THREATSCORE = "acme:searchCommand:acme_secops/threatscore"
XMLKV = "acme:searchCommand:search/xmlkv"
SEARCH = "acme:savedSearch:acme_secops/SOC - Threat Scores"


class Patched(FixtureTransport):
    def __init__(self, rest: dict[str, Any]):
        super().__init__(FIXTURE)
        self.rest = rest

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if path in self.rest:
            return copy.deepcopy(self.rest[path])
        return super().get(path, params)


def _build(transport=None, parts=None):
    bundle = build_here(transport or FixtureTransport(FIXTURE), "acme", parts=parts)
    return bundle, {e["id"]: e for e in bundle["entities"]}


def _ids(bundle, entity_type):
    return {e["id"] for e in bundle["entities"] if e["type"] == entity_type}


def test_commands_are_listed_with_their_app():
    bundle, by_id = _build()
    assert {THREATSCORE, XMLKV, "acme:searchCommand:search/iconify"} <= _ids(
        bundle, "searchCommand"
    )
    cmd = by_id[THREATSCORE]
    assert cmd["app"] == "acme_secops" and cmd["sharing"] == "app"
    p = cmd["properties"]
    assert p["filename"] == "threatscore.py" and p["protocol"] == "v2"
    assert p["streaming"] is True and p["generating"] is False and p["risky"] is False
    assert p["pythonRequired"] == "3.13"
    assert by_id[XMLKV]["properties"]["protocol"] == "v1"  # Splunk's own legacy command
    app_edges = {(x["from"], x["to"]) for x in bundle["edges"] if x["type"] == "contains"}
    assert ("acme:app:acme_secops", THREATSCORE) in app_edges


def test_searches_link_to_the_commands_they_run():
    bundle, _ = _build()
    uses = {(x["from"], x["to"]) for x in bundle["edges"] if x["type"] == "uses"}
    assert (SEARCH, THREATSCORE) in uses
    assert (SEARCH, XMLKV) in uses  # shared globally from the search app
    # Splunk's compiled commands (stats, where...) are not objects in the catalog.
    assert not any(t.startswith("acme:searchCommand:") and "stats" in t for _, t in uses)


def test_command_hidden_from_the_searchs_app_is_reported():
    searches = json.loads((FIXTURE / "servicesNS/-/-/saved/searches.json").read_text())
    for e in searches["entry"]:
        if e["name"] == "SOC - Threat Scores":
            e["acl"]["app"] = "acme_web"  # threatscore is shared with acme_secops only
    bundle, by_id = _build(Patched({"/servicesNS/-/-/saved/searches": searches}))
    moved = by_id["acme:savedSearch:acme_web/SOC - Threat Scores"]
    assert "searchCommand:threatscore" in moved["lineage"]["unresolved"]
    uses = {(x["from"], x["to"]) for x in bundle["edges"] if x["type"] == "uses"}
    assert (moved["id"], THREATSCORE) not in uses


def test_part_can_be_left_out():
    bundle, _ = _build(parts={"apps", "savedSearches", "macros"})
    assert not _ids(bundle, "searchCommand")


def test_analyzer_records_commands_after_pipes_and_in_subsearches():
    a = analyze(
        'index=web | mycmd x=1 | stats count [| search index=a | othercmd] | eval y="| fake"'
    )
    assert {"mycmd", "stats", "othercmd", "eval", "search"} <= a.commands
    assert "fake" not in a.commands
    assert "index=web" not in a.commands


class WithAdhoc(FixtureTransport):
    def __init__(self, rows: list[dict[str, Any]]):
        super().__init__(FIXTURE)
        self.rows = rows

    def search(self, name, spl, earliest="-24h", latest="now"):
        if name == "usage_adhoc_searches":
            return self.rows
        return super().search(name, spl, earliest, latest)


def test_adhoc_runs_count_as_use_of_a_command():
    _, by_id = _build()
    assert by_id["acme:searchCommand:search/iconify"]["usage"]["unused"] is True
    rows = [
        {
            "app": "search",
            "search": "'index=web | iconify clientip'",
            "runs": "9",
            "last": "1793943191",
        }
    ]
    _, by_id = _build(WithAdhoc(rows))
    u = by_id["acme:searchCommand:search/iconify"]["usage"]
    assert u["adhocSearches"] == 9 and not u.get("unused")
