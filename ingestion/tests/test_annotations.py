import json
from pathlib import Path

import pytest

from delvecat_ingest.annotations import AnnotationError, apply_annotations, load_annotations
from delvecat_ingest.bundle import apply_versions, assemble, validate
from delvecat_ingest.cli import main
from delvecat_ingest.model import ExtractResult, entity

REPO_ANNOTATIONS = Path(__file__).parents[2] / "annotations"
RECORDED = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
DEPLOYMENT_APPS = Path(__file__).parents[2] / "deploy" / "deployment-apps"


def make_bundle():
    ents = [
        entity(id="i:index:web", type="index", name="web", instance="i", app="acme_web"),
        entity(
            id="i:savedSearch:acme_web/Web - A",
            type="savedSearch",
            name="Web - A",
            instance="i",
            app="acme_web",
            description="from splunk",
        ),
        entity(
            id="i:savedSearch:acme_web/Other",
            type="savedSearch",
            name="Other",
            instance="i",
            app="acme_web",
        ),
        entity(id="i:macro:soc/m", type="macro", name="m", instance="i", app="soc"),
    ]
    return assemble(
        [{"id": "i", "name": "i", "kind": "splunkEnterprise"}], ExtractResult(entities=ents)
    )


def write(dir_: Path, name: str, text: str) -> None:
    (dir_ / name).parent.mkdir(parents=True, exist_ok=True)
    (dir_ / name).write_text(text)


def test_selectors_then_ids_and_list_union(tmp_path):
    d = tmp_path / "annotations"
    write(
        d,
        "a.yaml",
        """
annotations:
  - id: i:savedSearch:acme_web/Web - A
    description: Specific wins.
    tags: [b]
  - match: {type: savedSearch, app: acme_web, name: "Web - *"}
    description: Broad.
    owners: [web]
    tags: [a, b]
glossary:
  - term: Storefront
""",
    )
    write(
        d,
        "team/b.yaml",
        """
annotations:
  - match: {app: acme_*}
    owners: [platform, web]
    glossaryTerms: [Storefront]
    links: [{title: Wiki, url: "https://wiki.example.com/x"}]
""",
    )
    bundle = make_bundle()
    report = apply_annotations(
        bundle,
        load_annotations(d),
        {"repoUrl": "https://github.com/o/r", "branch": "main", "path": "annotations"},
    )
    assert validate(bundle) == []
    by = {e["id"]: e.get("annotations") for e in bundle["entities"]}
    a = by["i:savedSearch:acme_web/Web - A"]
    assert a["description"] == "Specific wins."
    assert a["owners"] == ["web", "platform"]
    assert a["tags"] == ["a", "b"]
    assert a["sources"] == [
        "annotations/a.yaml:6",
        "annotations/team/b.yaml:3",
        "annotations/a.yaml:3",
    ]
    assert a["primarySource"] == "annotations/a.yaml:3"
    assert by["i:savedSearch:acme_web/Other"]["owners"] == ["platform", "web"]
    assert "primarySource" not in by["i:savedSearch:acme_web/Other"]
    assert "description" not in by["i:savedSearch:acme_web/Other"]
    assert by["i:macro:soc/m"] is None
    assert report["status"] == "ok"
    assert report["counts"]["annotatedEntities"] == 3
    assert bundle["glossary"][0]["term"] == "Storefront"
    assert bundle["annotationSource"]["repoUrl"] == "https://github.com/o/r"
    # Splunk's own description is untouched
    assert {e["id"]: e for e in bundle["entities"]}["i:savedSearch:acme_web/Web - A"][
        "description"
    ] == "from splunk"


def test_reapplying_is_idempotent(tmp_path):
    d = tmp_path / "annotations"
    write(d, "a.yaml", "annotations:\n  - id: i:index:web\n    tags: [x]\n")
    bundle = make_bundle()
    anns = load_annotations(d)
    apply_annotations(bundle, anns)
    first = json.dumps(bundle, sort_keys=True)
    apply_annotations(bundle, anns)
    assert json.dumps(bundle, sort_keys=True) == first


def test_unmatched_entries_and_undefined_terms_are_reported(tmp_path):
    d = tmp_path / "annotations"
    write(
        d,
        "a.yaml",
        """annotations:
  - id: i:index:nope
    tags: [x]
  - match: {type: dashboard}
    tags: [y]
  - id: i:index:web
    glossaryTerms: [Undefined Thing]
""",
    )
    report = apply_annotations(make_bundle(), load_annotations(d))
    assert report["status"] == "partial"
    assert report["counts"]["unmatchedEntries"] == 2
    assert "annotations/a.yaml:2 (i:index:nope)" in report["message"]
    assert "Undefined Thing" in report["message"]


@pytest.mark.parametrize(
    "text,expected",
    [
        (
            "annotations:\n  - id: x\n    colour: red\n",
            "a.yaml:2: annotations/0: Additional properties",
        ),
        ("annotations:\n  - tags: [x]\n", "a.yaml:2: annotations/0"),
        ("annotations:\n  - id: x\n    match: {type: index}\n", "a.yaml:2"),
        ("annotations:\n  - id: x\n    links: [{url: not a url}]\n", "does not match '^https?://'"),
        ("annotations: [\n", "invalid YAML"),
    ],
)
def test_invalid_files_report_file_and_line(tmp_path, text, expected):
    d = tmp_path / "annotations"
    write(d, "a.yaml", text)
    with pytest.raises(AnnotationError) as exc:
        load_annotations(d)
    assert any(expected in p for p in exc.value.problems), exc.value.problems


def test_duplicate_glossary_terms_are_rejected(tmp_path):
    d = tmp_path / "annotations"
    write(d, "a.yaml", "glossary:\n  - term: SOC\n")
    write(d, "b.yaml", "glossary:\n  - term: soc\n")
    with pytest.raises(AnnotationError, match="already defined at annotations/a.yaml:2"):
        load_annotations(d)


def test_annotations_do_not_bump_versions(tmp_path):
    d = tmp_path / "annotations"
    write(d, "a.yaml", "annotations:\n  - id: i:index:web\n    tags: [x]\n")
    prev = make_bundle()
    apply_versions(prev["entities"], prev["generatedAt"], None)
    current = make_bundle()
    apply_annotations(current, load_annotations(d))
    changes = apply_versions(current["entities"], "2027-01-01T00:00:00Z", prev)
    assert changes["modified"] == []


def test_repo_annotations_are_valid_and_all_match_the_demo(tmp_path):
    out = tmp_path / "demo"
    assert (
        main(
            [
                "build",
                "--fixtures",
                str(RECORDED),
                "--instance",
                "acme",
                "--fields",
                "--deployment-apps-dir",
                str(DEPLOYMENT_APPS),
                "--max-field-sourcetypes",
                "10",
                "--strict",
                "--annotations",
                str(REPO_ANNOTATIONS),
                "--annotation-repo",
                "https://github.com/o/r",
                "--shard",
                "--out",
                str(out),
            ]
        )
        == 0
    )
    manifest = json.loads((out / "catalog.json").read_text())
    report = next(r for r in manifest["ingestionReport"] if r["connector"] == "annotations")
    assert report["status"] == "ok", report
    assert manifest["annotationSource"] == {
        "repoUrl": "https://github.com/o/r",
        "branch": "main",
        "path": "annotations",
    }


def test_cli_annotate_and_lint(tmp_path, capsys):
    base = tmp_path / "base.json"
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
                "--out",
                str(base),
            ]
        )
        == 0
    )
    out = tmp_path / "annotated.json"
    assert (
        main(["annotate", str(base), "--annotations", str(REPO_ANNOTATIONS), "--out", str(out)])
        == 0
    )
    annotated = json.loads(out.read_text())
    web = next(e for e in annotated["entities"] if e["id"] == "acme:index:web")
    assert "PII.IPAddress" in web["annotations"]["classifications"]
    assert main(["lint-annotations", str(REPO_ANNOTATIONS), "--bundle", str(out)]) == 0

    bad = tmp_path / "bad"
    write(bad, "x.yaml", "annotations:\n  - id: acme:index:nope\n")
    assert main(["lint-annotations", str(bad)]) == 0  # valid file...
    assert main(["lint-annotations", str(bad), "--bundle", str(out)]) == 3  # ...matches nothing
    assert (
        main(["annotate", str(base), "--annotations", str(bad), "--strict", "--out", str(out)]) == 3
    )
    write(bad, "y.yaml", "annotations:\n  - nope: 1\n")
    assert main(["lint-annotations", str(bad)]) == 4
    assert main(["annotate", str(base), "--out", str(out)]) == 2


def test_empty_template_fields_change_nothing(tmp_path):
    d = tmp_path / "annotations"
    write(
        d,
        "a.yaml",
        """annotations:
  - match: {type: index}
    description: Set by selector.
  - id: i:index:web
    description: ""
    owners: []
""",
    )
    bundle = make_bundle()
    apply_annotations(bundle, load_annotations(d))
    web = next(e for e in bundle["entities"] if e["id"] == "i:index:web")["annotations"]
    assert web["description"] == "Set by selector."
    assert "owners" not in web
