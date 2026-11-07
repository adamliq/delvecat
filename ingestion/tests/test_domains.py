import pytest

from delvecat_ingest.annotations import AnnotationError, apply_annotations, load_annotations
from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.merge import merge_bundles
from delvecat_ingest.model import ExtractResult, entity


def make_bundle(instance="i"):
    ents = [
        entity(
            id=f"{instance}:index:web", type="index", name="web", instance=instance, app="web_app"
        ),
        entity(
            id=f"{instance}:dashboard:web_app/d",
            type="dashboard",
            name="d",
            instance=instance,
            app="web_app",
        ),
        entity(
            id=f"{instance}:index:fw", type="index", name="fw", instance=instance, app="sec_app"
        ),
    ]
    return assemble(
        [{"id": instance, "name": instance, "kind": "splunkEnterprise"}],
        ExtractResult(entities=ents),
    )


def write(d, text):
    d.mkdir(exist_ok=True)
    (d / "a.yaml").write_text(text)
    return load_annotations(d)


DOMAINS = """
domains:
  - name: Security
    owners: [soc]
  - name: Web
    parent: Security
    description: Storefront
annotations:
  - match: {app: web_app}
    domain: Web
  - match: {type: index}
    domain: Security
  - id: i:index:web
    domain: Web
dataProducts:
  - name: Storefront
    domain: Web
    owners: [web-team]
    assets:
      - id: i:index:web
      - match: {type: dashboard}
"""


def test_domains_assigned_with_specific_entries_winning(tmp_path):
    b = make_bundle()
    report = apply_annotations(b, write(tmp_path / "ann", DOMAINS))
    assert validate(b) == []
    by = {e["id"]: e["annotations"] for e in b["entities"]}
    assert by["i:index:web"]["domain"] == "Web"  # its own entry beats the index rule
    assert by["i:index:fw"]["domain"] == "Security"
    assert by["i:dashboard:web_app/d"]["domain"] == "Web"
    assert [d["name"] for d in b["domains"]] == ["Security", "Web"]
    assert b["domains"][1]["parent"] == "Security"
    assert report["counts"]["domains"] == 2 and report["status"] == "ok"


def test_data_products_resolve_assets_both_ways(tmp_path):
    b = make_bundle()
    apply_annotations(b, write(tmp_path / "ann", DOMAINS))
    (product,) = b["dataProducts"]
    assert product["assets"] == ["i:dashboard:web_app/d", "i:index:web"]
    assert product["owners"] == ["web-team"] and product["domain"] == "Web"
    by = {e["id"]: e["annotations"] for e in b["entities"]}
    assert by["i:index:web"]["dataProducts"] == ["Storefront"]
    assert "dataProducts" not in by["i:index:fw"]


def test_unmatched_assets_and_undefined_domains_are_reported(tmp_path):
    b = make_bundle()
    report = apply_annotations(
        b,
        write(
            tmp_path / "ann",
            """
annotations:
  - match: {type: index}
    domain: Nowhere
dataProducts:
  - name: Ghost
    domain: Also Nowhere
    assets:
      - id: i:index:missing
""",
        ),
    )
    assert report["status"] == "partial"
    assert "data product 'Ghost' asset 1" in report["message"]
    assert "domains used but not defined: Also Nowhere, Nowhere" in report["message"]


def test_invalid_definitions(tmp_path):
    with pytest.raises(AnnotationError, match="already defined"):
        write(tmp_path / "a1", "domains:\n  - name: Web\n  - name: web\n")
    with pytest.raises(AnnotationError, match="assets"):
        write(tmp_path / "a2", "dataProducts:\n  - name: P\n")  # assets are required
    with pytest.raises(AnnotationError):
        write(tmp_path / "a3", "dataProducts:\n  - name: P\n    assets: [{name: x}]\n")


def test_merge_combines_domains_and_products(tmp_path):
    a, c = make_bundle("a"), make_bundle("c")
    apply_annotations(a, write(tmp_path / "x", DOMAINS.replace("i:index:web", "a:index:web")))
    apply_annotations(c, write(tmp_path / "y", DOMAINS.replace("i:index:web", "c:index:web")))
    m = merge_bundles([("a", a), ("c", c)])
    assert [d["name"] for d in m["domains"]] == ["Security", "Web"]
    (product,) = m["dataProducts"]
    assert "a:index:web" in product["assets"] and "c:index:web" in product["assets"]
    assert validate(m) == []
