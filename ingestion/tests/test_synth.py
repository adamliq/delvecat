"""The synthetic catalog used for performance testing builds, validates and is stable."""

import json

from delvecat_ingest.bundle import validate
from delvecat_ingest.cli import main
from delvecat_ingest.synth import build


def test_small_synthetic_catalog_is_valid_and_deterministic():
    quiet = lambda *_: None  # noqa: E731
    a = build(scale=0.02, seed=3, log=quiet)
    assert not validate(a)
    types = {e["type"] for e in a["entities"]}
    assert {
        "index",
        "sourcetype",
        "field",
        "savedSearch",
        "correlationSearch",
        "dashboard",
        "user",
    } <= types
    assert any(x["type"] == "readsField" for x in a["edges"])  # field lineage was derived
    assert any((e.get("governance") or {}).get("classifications") for e in a["entities"])
    b = build(scale=0.02, seed=3, log=quiet)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_synth_command_writes_a_sharded_bundle(tmp_path):
    assert main(["synth", "--scale", "0.01", "--out", str(tmp_path / "big"), "--shard"]) == 0
    manifest = json.loads((tmp_path / "big" / "catalog.json").read_text())
    assert manifest["shards"] and not manifest["entities"]
