import json
from pathlib import Path

from delvecat_ingest.cli import main

RECORDED = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


def build(out, *extra):
    return main(
        ["build", "--fixtures", str(RECORDED), "--instance", "acme", "--out", str(out), *extra]
    )


def test_build_validate_and_versioning(tmp_path, capsys):
    first = tmp_path / "v1.json"
    assert build(first, "--generated-at", "2026-11-01T00:00:00+00:00") == 0
    b1 = json.loads(first.read_text())
    assert b1["generatedAt"] == "2026-11-01T00:00:00Z"
    assert b1["instances"][0]["version"] == "9.4.17"
    assert all(e["version"] == 1 for e in b1["entities"])
    assert main(["validate", str(first)]) == 0

    second = tmp_path / "v2"
    assert (
        build(
            second,
            "--previous",
            str(first),
            "--shard",
            "--generated-at",
            "2026-11-02T00:00:00+00:00",
        )
        == 0
    )
    manifest = json.loads((second / "catalog.json").read_text())
    assert manifest["changes"] == {
        "previousGeneratedAt": "2026-11-01T00:00:00Z",
        "added": [],
        "removed": [],
        "modified": [],
    }
    assert manifest["shards"] and manifest["entities"] == []
    assert main(["validate", str(second)]) == 0
    out = capsys.readouterr().out
    assert "changes since 2026-11-01T00:00:00Z: +0 -0 ~0" in out


def test_only_and_unknown_extractor(tmp_path, capsys):
    out = tmp_path / "o.json"
    assert build(out, "--only", "indexes,roles") == 0
    types = {e["type"] for e in json.loads(out.read_text())["entities"]}
    assert types == {"index", "role"}
    assert build(out, "--only", "nope") == 2


def test_live_mode_requires_token(tmp_path, monkeypatch):
    monkeypatch.delenv("DELVECAT_SPLUNK_TOKEN", raising=False)
    assert (
        main(
            [
                "build",
                "--url",
                "https://x:8089",
                "--instance",
                "x",
                "--out",
                str(tmp_path / "x.json"),
            ]
        )
        == 2
    )
