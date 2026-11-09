"""Building inside Splunk (the app's | delvecatbuild) matches the command-line build."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from delvecat_ingest.bundle import validate
from delvecat_ingest.cli import main
from delvecat_ingest.inapp import build_here, default_instance_id
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
AS_OF = "2026-01-01T00:00:00+00:00"


def test_same_catalog_as_the_cli(tmp_path):
    steps: list[str] = []
    here = build_here(FixtureTransport(FIXTURE), "acme", "Acme", progress=steps.append)
    out = tmp_path / "cli.json"
    assert main(["build", "--fixtures", str(FIXTURE), "--instance", "acme",
                 "--instance-name", "Acme", "--out", str(out)]) == 0  # fmt: skip
    cli = json.loads(out.read_text())
    assert validate(here) == []
    assert sorted(e["id"] for e in here["entities"]) == sorted(e["id"] for e in cli["entities"])
    assert len(here["edges"]) == len(cli["edges"])
    assert "splunk.indexes" in steps and "products.enterpriseSecurity" in steps
    assert steps[-2:] == ["assemble", "governance"]


def test_previous_catalog_keeps_first_seen():
    t = FixtureTransport(FIXTURE)
    first = build_here(t, "acme")
    again = build_here(t, "acme", previous=first)
    seen = {e["id"]: e.get("firstSeenAt") for e in first["entities"]}
    assert all(e.get("firstSeenAt") == seen[e["id"]] for e in again["entities"])


def test_internal_redaction_and_limits():
    bundle = build_here(FixtureTransport(FIXTURE), "acme", redact="internal")
    assert bundle["redaction"]["profile"] == "internal"
    with pytest.raises(ValueError, match="public"):
        build_here(FixtureTransport(FIXTURE), "acme", redact="public")
    with pytest.raises(ValueError, match="instance id"):
        build_here(FixtureTransport(FIXTURE), "bad id")


def test_default_instance_id_is_the_server_name():
    assert default_instance_id(FixtureTransport(FIXTURE)) not in ("", None)
    assert default_instance_id(FixtureTransport(Path("/nonexistent"))) == "splunk"


def test_only_the_chosen_parts_run():
    steps: list[str] = []
    bundle = build_here(
        FixtureTransport(FIXTURE), "acme", parts={"indexes", "fields"}, progress=steps.append
    )
    ran = [s for s in steps if "." in s]
    # fields needs the inventory, which is added; nothing else runs.
    assert ran == ["splunk.indexes", "splunk.inventory", "splunk.fields"]
    types = {e["type"] for e in bundle["entities"]}
    assert {"index", "field"} <= types and "savedSearch" not in types
    with pytest.raises(ValueError, match="unknown part"):
        build_here(FixtureTransport(FIXTURE), "acme", parts={"nope"})


def test_products_only_and_all_parts():
    from delvecat_ingest.inapp import PARTS, resolve_parts

    steps: list[str] = []
    build_here(
        FixtureTransport(FIXTURE), "acme", parts={"enterpriseSecurity"}, progress=steps.append
    )
    assert [s for s in steps if "." in s] == ["products.enterpriseSecurity"]
    assert resolve_parts(None) == set(PARTS) and "fields" in PARTS and "dbConnect" in PARTS


def test_build_page_lists_every_part():
    """The Splunk app's Build page names the parts itself (web/src/lib/splunkBuild.ts)."""
    import re

    from delvecat_ingest.inapp import PARTS

    source = Path(__file__).parents[2] / "web" / "src" / "lib" / "splunkBuild.ts"
    listed = re.findall(r'\{ id: "(\w+)"', source.read_text(encoding="utf-8"))
    assert sorted(listed) == sorted(PARTS)
