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


class SpyTransport(FixtureTransport):
    """Recorded responses, noting each search's SPL."""

    def __init__(self, root):
        super().__init__(root)
        self.spl: dict[str, str] = {}

    def search(self, name, spl, *args, **kwargs):
        self.spl[name] = spl
        return super().search(name, spl, *args, **kwargs)


def _sourcetype_indexes(bundle):
    return {
        e["name"]: set(e["properties"]["observed"]["eventsByIndex"])
        for e in bundle["entities"]
        if e["type"] == "sourcetype" and (e.get("properties") or {}).get("observed")
    }


def test_field_samples_search_only_where_the_sourcetype_is():
    spy = SpyTransport(FIXTURE)
    bundle = build_here(spy, "acme", parts={"fields"})
    seen = _sourcetype_indexes(bundle)
    samples = {k.split("/", 1)[1]: v for k, v in spy.spl.items() if k.startswith("fieldsummary/")}
    assert samples
    for st, spl in samples.items():
        assert "index=*" not in spl
        assert all(f'index="{i}"' in spl for i in seen[st])


def test_field_discovery_limited_to_chosen_indexes():
    from delvecat_ingest.connectors.splunk.data import parse_index_list

    assert parse_index_list(" main, web_* ,main") == ("main", "web_*")
    assert parse_index_list("") is None
    with pytest.raises(ValueError, match="invalid index"):
        parse_index_list('main" OR index=x')

    everything = build_here(FixtureTransport(FIXTURE), "acme", parts={"fields"})
    target = sorted({i for idx in _sourcetype_indexes(everything).values() for i in idx})[0]
    spy = SpyTransport(FIXTURE)
    bundle = build_here(spy, "acme", parts={"fields"}, field_indexes=target)
    sampled = [k.split("/", 1)[1] for k in spy.spl if k.startswith("fieldsummary/")]
    seen = _sourcetype_indexes(bundle)
    assert sampled and all(target in seen[st] for st in sampled)
    assert all(spy.spl[f"fieldsummary/{st}"].startswith(f'(index="{target}")') for st in sampled)
    fields_of = {e["properties"]["sourcetype"] for e in bundle["entities"] if e["type"] == "field"}
    assert fields_of <= set(sampled)

    none = build_here(FixtureTransport(FIXTURE), "acme", parts={"fields"}, field_indexes="nope_*")
    report = next(r for r in none["ingestionReport"] if r["connector"] == "splunk.fields")
    assert report["status"] == "partial" and "nope_*" in report["message"]


def test_cli_field_indexes(tmp_path, capsys):
    out = tmp_path / "c.json"
    base = [
        "build",
        "--fixtures",
        str(FIXTURE),
        "--instance",
        "acme",
        "--fields",
        "--out",
        str(out),
    ]
    assert main([*base, "--field-indexes", "bad name"]) == 2
    assert "invalid index" in capsys.readouterr().err
    assert main([*base, "--field-indexes", "main,_internal"]) == 0
