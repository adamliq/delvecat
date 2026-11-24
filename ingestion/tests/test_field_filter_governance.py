"""Field filters mask classified columns: governance marks them and does not count a
store as exposed when every sensitive column in it is masked."""

from __future__ import annotations

from delvecat_ingest.governance import apply_governance


def ent(type_, name, **extra):
    return {"id": f"i:{type_}:{name}", "type": type_, "name": name, "instance": "i", **extra}


def build(filters):
    field = ent("field", "web/clientip", properties={"sourcetype": "web", "field": "clientip"},
                annotations={"classifications": ["PII.IPAddress"]})  # fmt: skip
    st, idx = ent("sourcetype", "web"), ent("index", "web")
    user = ent("role", "user", properties={})
    bundle = {
        "entities": [field, st, idx, user, *filters],
        "edges": [
            {"from": st["id"], "to": field["id"], "type": "contains"},
            {"from": st["id"], "to": idx["id"], "type": "feeds"},
            {"from": user["id"], "to": idx["id"], "type": "grantsAccess"},
        ],
        "classifications": [{"name": "PII", "sensitive": True}],
    }
    summary = apply_governance(bundle)
    return {e["id"]: e for e in bundle["entities"]}, summary


def ffilter(name, **props):
    return ent("fieldFilter", name, properties={"field": "clientip", "indexes": ["web"], **props})


def test_without_filters_the_index_is_exposed():
    by_id, summary = build([])
    assert by_id["i:index:web"]["governance"]["access"]["everyone"]
    assert summary["exposedToEveryone"] == 1 and summary["maskedByFieldFilters"] == 0


def test_a_hashing_filter_masks_the_column_everywhere():
    f = ffilter("hash_ip", action="hash", hash="sha256", roleExemptions=["soc"])
    by_id, summary = build([f])
    for eid in ("i:index:web", "i:sourcetype:web", "i:field:web/clientip"):
        cls = by_id[eid]["governance"]["classifications"][0]
        assert cls["maskedBy"] == [f["id"]], eid
    access = by_id["i:index:web"]["governance"]["access"]
    assert access["masked"] and access["unmaskedRoles"] == []
    assert summary["exposedToEveryone"] == 0 and summary["maskedByFieldFilters"] == 3


def test_filters_elsewhere_or_rewriting_raw_do_not_mask():
    other_index = ffilter("other", action="remove", indexes=["main"])
    sed = ffilter("sed", action="sed", sed="s/a/b/")
    other_st = ffilter("st", action="remove", limit={"type": "sourcetype", "values": ["fw"]})
    by_id, summary = build([other_index, sed, other_st])
    assert "maskedBy" not in by_id["i:index:web"]["governance"]["classifications"][0]
    assert summary["exposedToEveryone"] == 1


def test_a_sourcetype_limited_filter_masks_that_sourcetype_not_the_whole_index():
    f = ffilter(
        "st", action="replace", replacement="x", limit={"type": "sourcetype", "values": ["web"]}
    )
    by_id, _ = build([f])
    assert by_id["i:sourcetype:web"]["governance"]["classifications"][0]["maskedBy"] == [f["id"]]
    assert "maskedBy" not in by_id["i:index:web"]["governance"]["classifications"][0]
