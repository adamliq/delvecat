import json
from pathlib import Path

import pytest

from delvecat_ingest.bundle import load_bundle, validate
from delvecat_ingest.cli import main
from delvecat_ingest.redaction import load_profile, redact_bundle

HERE = Path(__file__).parent
RECORDED = HERE / "fixtures" / "splunk-9.4-dev"
ANNOTATIONS = HERE.parents[1] / "annotations"
APPS = HERE.parents[1] / "deploy" / "deployment-apps"


@pytest.fixture(scope="module")
def plain(tmp_path_factory):
    out = tmp_path_factory.mktemp("b") / "plain.json"
    assert (
        main(
            [
                "build",
                "--fixtures",
                str(RECORDED),
                "--instance",
                "acme",
                "--fields",
                "--max-field-sourcetypes",
                "10",
                "--deployment-apps-dir",
                str(APPS),
                "--annotations",
                str(ANNOTATIONS),
                "--out",
                str(out),
            ]
        )
        == 0
    )
    return out


SECRETS = [
    "jlee",
    "mpatel",
    "Jordan Lee",
    "Mira Patel",
    "uf-linux-01",
    "fw-edge-1",
    "dc01",
    "streamfwd-dmz-01",
    "dbx-hf-01",
    "mysql.internal.example",
    "intel.example.com",
    "10.0.0.",
    "172.18.",
]


def test_public_profile_leaves_no_personal_or_host_data(plain):
    b = load_bundle(plain)
    assert any(s in json.dumps(b) for s in SECRETS)  # they are there before redaction
    redact_bundle(b, load_profile("public"), salt="s")
    text = json.dumps(b)
    assert [s for s in SECRETS if s in text] == []
    assert validate(b) == []
    ids = {e["id"] for e in b["entities"]}
    assert all(e["from"] in ids and e["to"] in ids for e in b["edges"])
    users = [e for e in b["entities"] if e["type"] == "user"]
    assert all(u["name"].startswith("user-") and "displayName" not in u for u in users)
    private = [e for e in b["entities"] if "/@" in e["id"]]
    assert private and all("/@user-" in e["id"] for e in private)
    web = next(e for e in b["entities"] if e["id"] == "acme:index:web")
    assert all(u.startswith("acme:user:user-") for u in web["governance"]["access"]["users"])
    assert b["redaction"] == {
        "profile": "public",
        "stablePseudonyms": True,
        "counts": b["redaction"]["counts"],
    }


def test_pseudonyms_are_stable_with_a_salt(plain):
    a, b, c = load_bundle(plain), load_bundle(plain), load_bundle(plain)
    for x, salt in ((a, "same"), (b, "same"), (c, "other")):
        redact_bundle(x, load_profile("public"), salt=salt)
    names = [sorted(e["name"] for e in x["entities"] if e["type"] == "user") for x in (a, b, c)]
    assert names[0] == names[1] != names[2]


def test_random_salt_is_reported(plain, monkeypatch):
    monkeypatch.delenv("DELVECAT_REDACT_SALT", raising=False)
    b = load_bundle(plain)
    redact_bundle(b, load_profile("public"))
    assert b["redaction"]["stablePseudonyms"] is False


def test_internal_profile_drops_only_real_names(plain):
    b = load_bundle(plain)
    redact_bundle(b, load_profile("internal"))
    text = json.dumps(b)
    assert "Jordan Lee" not in text and "jlee" in text and "uf-linux-01" in text


def test_profile_file_and_cli(plain, tmp_path, monkeypatch):
    monkeypatch.setenv("DELVECAT_REDACT_SALT", "x")
    prof = tmp_path / "hosts-only.yaml"
    prof.write_text("extends: internal\nhosts: pseudonymize\n")
    out = tmp_path / "r.json"
    assert main(["redact", str(plain), "--redact-profile-file", str(prof), "--out", str(out)]) == 0
    text = out.read_text()
    assert "uf-linux-01" not in text and "jlee" in text
    assert json.loads(text)["redaction"]["profile"] == "hosts-only"
    (tmp_path / "bad.yaml").write_text("ips: scramble\n")
    assert (
        main(
            [
                "redact",
                str(plain),
                "--redact-profile-file",
                str(tmp_path / "bad.yaml"),
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert main(["redact", str(plain), "--out", str(out)]) == 2
