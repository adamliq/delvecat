"""Ad-hoc searches as catalog objects: the most-run searches people typed, with their SPL."""

from __future__ import annotations

from pathlib import Path

from delvecat_ingest.bundle import apply_versions
from delvecat_ingest.connectors.splunk.common import Ctx, Options
from delvecat_ingest.connectors.splunk.usage import (
    adhoc_name,
    adhoc_title,
    extract_adhoc_searches,
)
from delvecat_ingest.inapp import build_here
from delvecat_ingest.model import ExtractResult
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
WEB = "search index=web sourcetype=access_combined status>=500 | stats count by uri_path"


def row(search, app="search", prov="UI:Search", runs=3, users=2, last="1793943191"):
    return {"app": app, "provenance": prov, "search": f"'{search}'", "runs": str(runs),
            "users": str(users), "last": last}  # fmt: skip


class Rows(FixtureTransport):
    def __init__(self, rows):
        super().__init__(FIXTURE)
        self.rows = rows

    def search(self, name, spl, earliest="-24h", latest="now"):
        if name == "usage_adhoc_searches":
            return self.rows
        return super().search(name, spl, earliest, latest)


def _adhoc(rows):
    bundle = build_here(Rows(rows), "acme")
    return bundle, {e["id"]: e for e in bundle["entities"] if e["type"] == "adhocSearch"}


def test_searches_become_objects_with_spl_runs_users_and_lineage():
    bundle, objs = _adhoc(
        [
            row(WEB, runs=7, users=3, last="1793943191"),
            row(WEB, prov="rest", runs=2, users=1, last="1793000000"),  # same text, same app
            row("| inputlookup x.csv", prov="UI:Dashboard:web_overview", runs=40),
            row("search index=* error"),
            row("summarize action=probe id=x", prov="summary_director", runs=99),
            row("| delvecatbuild dryrun=true", prov="rest:jobs", runs=99),
        ]
    )
    oid = f"acme:adhocSearch:{adhoc_name('search', WEB)}"
    o = objs[oid]
    assert o["properties"]["search"] == WEB
    assert o["displayName"] == adhoc_title(WEB)
    assert o["usage"]["runs"] == 9 and o["usage"]["users"] == 3
    assert o["usage"]["lastUsed"].startswith("2026-11")
    assert o["properties"]["runFrom"] == ["REST API", "Search"]
    # Splunk's own searches and this app's build command are not objects.
    assert len(objs) == 2
    assert o["app"] == "search"
    # Dashboard panels belong to their dashboards, not ad-hoc objects.
    assert not any("inputlookup" in e["properties"]["search"] for e in objs.values())
    reads = {x["to"] for x in bundle["edges"] if x["from"] == oid and x["type"] == "reads"}
    assert "acme:index:web" in reads and "acme:sourcetype:access_combined" in reads
    # "index=*" typed at the search bar is not a read of every index.
    star = next(i for i, e in objs.items() if "error" in e["properties"]["search"])
    assert not [x for x in bundle["edges"] if x["from"] == star and ":index:" in x["to"]]


def test_names_are_stable_and_whitespace_insensitive():
    assert adhoc_name("search", "index=web  | stats count") == adhoc_name(
        "search", "index=web\n| stats count"
    )
    assert adhoc_name("search", WEB) != adhoc_name("other", WEB)
    assert adhoc_title("a" * 200).endswith("…") and len(adhoc_title("a" * 200)) == 90


def test_only_the_most_run_are_kept():
    rows = [row(f"index=web {i}", runs=i) for i in range(1, 6)]
    out = ExtractResult()
    extract_adhoc_searches(Ctx(Rows(rows), "acme", Options(adhoc_objects=2)), out)
    assert sorted(e["usage"]["runs"] for e in out.entities if e["type"] == "adhocSearch") == [4, 5]
    assert len(out.adhoc_searches) == 5  # all still count towards the objects they use
    out = ExtractResult()
    extract_adhoc_searches(Ctx(Rows(rows), "acme", Options(adhoc_objects=0)), out)
    assert not out.entities


def test_ad_hoc_searches_are_not_reported_as_changes():
    bundle, objs = _adhoc([row(WEB)])
    previous = {**bundle, "entities": [e for e in bundle["entities"] if e["id"] not in objs]}
    old = {"id": "acme:adhocSearch:old", "type": "adhocSearch", "name": "old"}
    previous["entities"].append(old)
    changes = apply_versions(bundle["entities"], "2026-11-24T00:00:00Z", previous)
    assert not set(changes["added"]) & set(objs)
    assert not [r for r in changes["removed"] if r["type"] == "adhocSearch"]


def test_public_profile_drops_the_typed_text():
    bundle, objs = _adhoc([row(WEB)])
    counts = redact_bundle(bundle, load_profile("public"), salt="s")
    o = next(e for e in bundle["entities"] if e["type"] == "adhocSearch")
    assert "search" not in o.get("properties", {})
    assert o["displayName"] == "Ad-hoc search in search"
    assert counts["adhocSearches"] == 1
    assert any(x["from"] == o["id"] for x in bundle["edges"])  # what it reads stays

    bundle, _ = _adhoc([row(WEB)])
    redact_bundle(bundle, load_profile("internal"))
    o = next(e for e in bundle["entities"] if e["type"] == "adhocSearch")
    assert o["properties"]["search"] == WEB
