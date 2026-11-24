"""Searches the analyser cannot follow are parsed by Splunk (search/parser) and lineage
is derived from Splunk's version."""

from __future__ import annotations

import copy
from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.parser_assist import splunk_spl
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
SAVED = "/servicesNS/-/-/saved/searches"
HIDDEN = "`private_web_events` | stats count by status"


class Parsing(FixtureTransport):
    """Adds a search using a macro the catalog cannot see; Splunk's parser expands it."""

    def __init__(self, answer=True):
        super().__init__(FIXTURE)
        self.asked: list[tuple[str, str]] = []
        self.answer = answer

    def get(self, path, params=None):
        body = super().get(path, params)
        if path == SAVED:
            body = copy.deepcopy(body)
            e = copy.deepcopy(next(x for x in body["entry"] if x["acl"]["app"] == "acme_web"))
            e["name"] = "Status from a private macro"
            e["content"].update({"search": HIDDEN, "disabled": False})
            for k in list(e["content"]):
                if k.startswith("action.correlationsearch"):
                    e["content"].pop(k)
            body["entry"].append(e)
            body["paging"] = {**body.get("paging", {}), "total": len(body["entry"])}
        return body

    def parse_spl(self, app, spl):
        self.asked.append((app, spl))
        if not self.answer:
            return None
        return {
            "commands": [
                {"command": "search", "rawargs": "index=web sourcetype=access_combined "},
                {"command": "stats", "rawargs": "count by status "},
            ]
        }


def _search(bundle):
    return next(e for e in bundle["entities"] if e["name"] == "Status from a private macro")


def test_splunk_parses_what_the_analyser_cannot_follow():
    t = Parsing()
    bundle = build_here(t, "acme")
    s = _search(bundle)
    # Searches with macros the catalog cannot see, each in its own app; clean ones are not sent.
    assert ("acme_web", HIDDEN) in t.asked
    assert all("`" in spl for _, spl in t.asked)
    assert s["lineage"]["parsedBySplunk"] is True
    assert "unresolved" not in s["lineage"]
    reads = {x["to"] for x in bundle["edges"] if x["from"] == s["id"] and x["type"] == "reads"}
    assert {"acme:index:web", "acme:sourcetype:access_combined"} <= reads
    report = next(r for r in bundle["ingestionReport"] if r["connector"] == "splunk.parserAssist")
    assert report["counts"] == {"tried": len(t.asked), "parsed": len(t.asked)}


def test_without_an_answer_the_search_keeps_its_broken_reference():
    bundle = build_here(Parsing(answer=False), "acme")
    s = _search(bundle)
    assert "parsedBySplunk" not in s["lineage"]
    assert any("private_web_events" in u for u in s["lineage"]["unresolved"])


def test_splunk_spl_rebuilds_the_pipeline():
    two = [{"command": "search", "rawargs": "index=a "}, {"command": "head", "rawargs": "5"}]
    assert splunk_spl({"commands": two}) == "search index=a | head 5"
    assert splunk_spl({"commands": [{"command": "tstats", "rawargs": "count"}]}) == "| tstats count"
    assert splunk_spl({"commands": []}) is None
