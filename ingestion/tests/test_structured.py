import pytest

from delvecat_ingest.annotations import AnnotationError, apply_annotations, load_annotations
from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.merge import merge_bundles
from delvecat_ingest.model import ExtractResult, entity

DEFS = """
structuredProperties:
  - id: tier
    type: string
    allowedValues: [hot, {value: cold, description: rarely searched}]
    appliesTo: [index]
    required: true
  - id: scope
    type: string
    cardinality: multiple
  - id: reviewed
    type: date
  - id: cost
    type: number
  - id: link
    type: url
  - id: critical
    type: boolean
    required: true
    requiredWhere: {type: savedSearch, app: sec*}
"""


def make_bundle(instance="i"):
    ents = [
        entity(id=f"{instance}:index:web", type="index", name="web", instance=instance, app="a"),
        entity(id=f"{instance}:index:fw", type="index", name="fw", instance=instance, app="a"),
        entity(
            id=f"{instance}:index:_audit",
            type="index",
            name="_audit",
            instance=instance,
            properties={"internal": True},
        ),
        entity(
            id=f"{instance}:savedSearch:sec_app/s",
            type="savedSearch",
            name="s",
            instance=instance,
            app="sec_app",
            sharing="app",
        ),
        entity(
            id=f"{instance}:savedSearch:web_app/t",
            type="savedSearch",
            name="t",
            instance=instance,
            app="web_app",
            sharing="app",
        ),
    ]
    return assemble(
        [{"id": instance, "name": instance, "kind": "splunkEnterprise"}],
        ExtractResult(entities=ents),
    )


def load(tmp_path, body, name="a"):
    d = tmp_path / name
    d.mkdir()
    (d / "p.yaml").write_text(DEFS + body)
    return load_annotations(d)


def props(b, eid):
    e = next(x for x in b["entities"] if x["id"] == eid)
    return (e.get("annotations") or {}).get("properties"), (e.get("annotations") or {}).get(
        "missingProperties"
    )


def test_values_typed_merged_and_required_tracked(tmp_path):
    b = make_bundle()
    report = apply_annotations(
        b,
        load(
            tmp_path,
            """
annotations:
  - match: {type: index}
    properties: {tier: cold, scope: [GDPR]}
  - id: i:index:web
    properties: {tier: hot, scope: [PCI, GDPR], reviewed: 2026-01-31, cost: 12.5,
                 link: "https://wiki.example.com/web"}
""",
        ),
    )
    assert validate(b) == []
    web, web_missing = props(b, "i:index:web")
    assert web == {
        "tier": "hot",
        "scope": ["GDPR", "PCI"],
        "reviewed": "2026-01-31",
        "cost": 12.5,
        "link": "https://wiki.example.com/web",
    }
    assert web_missing is None
    assert props(b, "i:index:fw")[0] == {"tier": "cold", "scope": ["GDPR"]}
    assert props(b, "i:index:_audit") == ({"tier": "cold", "scope": ["GDPR"]}, None)
    # required: only customer content, and requiredWhere narrows it
    assert props(b, "i:savedSearch:sec_app/s")[1] == ["critical"]
    assert props(b, "i:savedSearch:web_app/t")[1] is None
    assert report["counts"]["missingRequiredValues"] == 1
    assert "critical (1)" in report["message"]
    assert [d["id"] for d in b["structuredProperties"]] == [
        "cost",
        "critical",
        "link",
        "reviewed",
        "scope",
        "tier",
    ]


def test_misapplied_types_are_skipped_and_noted(tmp_path):
    b = make_bundle()
    report = apply_annotations(
        b,
        load(
            tmp_path,
            """
annotations:
  - match: {type: savedSearch}
    properties: {tier: hot}
""",
        ),
    )
    assert props(b, "i:savedSearch:web_app/t")[0] is None
    assert "tier on savedSearch" in report["message"]


@pytest.mark.parametrize(
    "body,expected",
    [
        (
            "annotations:\n  - id: x\n    properties: {nope: 1}\n",
            "unknown structured property 'nope'",
        ),
        (
            "annotations:\n  - id: x\n    properties: {tier: warm}\n",
            "'warm' is not an allowed value",
        ),
        ("annotations:\n  - id: x\n    properties: {tier: [hot]}\n", "takes a single value"),
        ("annotations:\n  - id: x\n    properties: {cost: cheap}\n", "expects a number"),
        ("annotations:\n  - id: x\n    properties: {reviewed: soon}\n", "expects a date"),
        ("annotations:\n  - id: x\n    properties: {link: wiki}\n", "expects a url"),
        ("annotations:\n  - id: x\n    properties: {critical: yes please}\n", "expects a boolean"),
        ("  - id: tier\n", "already defined"),  # continues the definitions list
    ],
)
def test_invalid_values_report_file_and_line(tmp_path, body, expected):
    with pytest.raises(AnnotationError) as exc:
        load(tmp_path, body)
    assert any(expected in p for p in exc.value.problems), exc.value.problems
    if "annotations:" in body:
        assert any("p.yaml:" in p for p in exc.value.problems)


def test_bad_allowed_value_type(tmp_path):
    d = tmp_path / "b"
    d.mkdir()
    (d / "p.yaml").write_text(
        "structuredProperties:\n  - id: n\n    type: number\n    allowedValues: [1, two]\n"
    )
    with pytest.raises(AnnotationError, match="allowed value 'two'"):
        load_annotations(d)


def test_merge_keeps_definitions(tmp_path):
    a, c = make_bundle("a"), make_bundle("c")
    apply_annotations(a, load(tmp_path, "", "x"))
    apply_annotations(c, load(tmp_path, "", "y"))
    m = merge_bundles([("a", a), ("c", c)])
    assert len(m["structuredProperties"]) == 6 and validate(m) == []
