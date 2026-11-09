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
