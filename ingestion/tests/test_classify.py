"""Column-aware classification propagation (governance)."""

from delvecat_ingest.governance import apply_governance
from delvecat_ingest.spl_fields import analyze_fields


def ent(type_, name, **kw):
    return {
        "id": f"i:{type_}:{name}",
        "type": type_,
        "name": name,
        "product": "splunk",
        "instance": "i",
        **kw,
    }


def search(name, spl, **kw):
    return ent("savedSearch", name, lineage={"fields": analyze_fields(spl).to_json()}, **kw)


def E(a, type_, b):
    return {"from": a["id"], "to": b["id"], "type": type_}


def gov(e):
    return e.get("governance") or {}


def classes(e):
    return {c["name"]: c for c in gov(e).get("classifications", [])}


def build(extra_entities, extra_edges, idx_annotations=None):
    st = ent("sourcetype", "acme:fw")
    src_ip = ent(
        "field",
        "acme:fw/src_ip",
        properties={"field": "src_ip"},
        annotations={"classifications": ["PII.IPAddress"]},
    )
    action = ent("field", "acme:fw/action", properties={"field": "action"})
    src = ent("field", "acme:fw/src", properties={"field": "src"})
    alias = ent(
        "fieldAlias", "TA/acme:fw : FIELDALIAS-src", properties={"aliases": {"0.src_ip": "src"}}
    )
    idx = ent("index", "fw", **({"annotations": idx_annotations} if idx_annotations else {}))
    entities = [st, src_ip, action, src, alias, idx, *extra_entities]
    edges = [
        E(st, "contains", src_ip),
        E(st, "contains", action),
        E(st, "contains", src),
        E(alias, "readsField", src_ip),
        E(alias, "definesField", src),
        E(st, "uses", alias),
        E(st, "feeds", idx),
        *extra_edges,
    ]
    bundle = {
        "entities": entities,
        "edges": edges,
        "classifications": [{"name": "PII", "sensitive": True}],
    }
    apply_governance(bundle)
    return {e["name"]: e for e in entities}


def writer(name, spl, out_name, **kw):
    s, out = search(name, spl, **kw), ent("index", out_name)
    return s, out


def test_only_columns_from_classified_fields_carry_it():
    a, s1 = writer("counts", "index=fw | stats count by action", "s1")
    b, s2 = writer("by_ip", "index=fw | stats count by src_ip", "s2")
    c, s3 = writer("distinct", "index=fw | stats dc(src_ip) as hosts by action", "s3")
    d = ent("savedSearch", "no_fields")  # no field lineage: conservative
    s4 = ent("index", "s4")
    entities = [a, s1, b, s2, c, s3, d, s4]
    idx = {"id": "i:index:fw"}
    edges = [
        E(a, "reads", idx),
        E(a, "writes", s1),
        E(b, "reads", idx),
        E(b, "writes", s2),
        E(c, "reads", idx),
        E(c, "writes", s3),
        E(d, "reads", idx),
        E(d, "writes", s4),
    ]
    n = build(entities, edges)
    assert classes(n["fw"])["PII.IPAddress"]["columns"] == ["src", "src_ip"]  # alias included
    assert classes(n["acme:fw/src"])["PII.IPAddress"]["how"] == "derivedField"
    assert "PII.IPAddress" not in classes(n["s1"])
    assert classes(n["s2"])["PII.IPAddress"] == {
        "name": "PII.IPAddress",
        "via": b["id"],
        "derived": True,
        "how": "lineage",
        "columns": ["src_ip"],
        "sensitive": True,
    }
    assert "PII.IPAddress" not in classes(n["s3"])  # a distinct count hides the values
    # No field references: fields pass through unchanged, so the classified columns do too.
    assert classes(n["s4"])["PII.IPAddress"]["columns"] == ["src", "src_ip"]
    # Only searches that use a classified column read it.
    assert "readsClassified" not in gov(n["counts"])
    assert gov(n["by_ip"])["readsClassified"] == ["PII.IPAddress"]
    assert gov(n["distinct"])["readsClassified"] == ["PII.IPAddress"]
    assert gov(n["no_fields"])["readsClassified"] == ["PII.IPAddress"]


def test_alias_and_chains():
    g, s1 = writer("by_src", "index=fw | stats count by src | rename src as host_ip", "s1")
    h = search("reread", "index=s1 | table host_ip count")
    lk = ent("lookup", "hosts")
    n = build(
        [g, s1, h, lk],
        [
            E(g, "reads", {"id": "i:index:fw"}),
            E(g, "writes", s1),
            E(h, "reads", s1),
            E(h, "writes", lk),
        ],
    )
    assert classes(n["s1"])["PII.IPAddress"]["columns"] == ["host_ip"]
    assert classes(n["hosts"])["PII.IPAddress"]["columns"] == ["host_ip"]
    assert gov(n["reread"])["readsClassified"] == ["PII.IPAddress"]


def test_stops():
    masked = search(
        "masked", "index=fw | table src_ip action", annotations={"stopsClassifications": ["PII"]}
    )
    s1 = ent("index", "s1")
    n = build([masked, s1], [E(masked, "reads", {"id": "i:index:fw"}), E(masked, "writes", s1)])
    assert "PII.IPAddress" not in classes(n["s1"])
    assert gov(n["masked"])["stops"] == ["PII.IPAddress"]
    assert gov(n["masked"])["readsClassified"] == ["PII.IPAddress"]  # it still reads it


def test_whole_object_classification_and_data_models():
    a, s1 = writer("counts", "index=fw | stats count by action", "s1")
    f, s2 = writer("total", "index=fw | stats count", "s2")
    dm = ent("dataModel", "Network")
    s3 = ent("index", "s3")
    t = search("dm_search", "| tstats count from datamodel=Network by Network.dest")
    idx = {"id": "i:index:fw"}
    n = build(
        [a, s1, f, s2, dm, s3, t],
        [
            E(a, "reads", idx),
            E(a, "writes", s1),
            E(f, "reads", idx),
            E(f, "writes", s2),
            E(dm, "reads", idx),
            E(t, "reads", dm),
            E(t, "writes", s3),
        ],
        idx_annotations={"classifications": ["PII"]},
    )
    assert "columns" not in classes(n["fw"])["PII"]
    # With the whole index classified, any column made from its fields carries it...
    assert classes(n["s1"])["PII"]["columns"] == ["action"]
    # ...but a bare count does not.
    assert "PII" not in classes(n["s2"])
    # Data model fields are named differently, so the data model is classified as a whole.
    assert "columns" not in classes(n["Network"])["PII"]
    assert classes(n["s3"])["PII"]["columns"] == ["Network.dest"]


def test_lookup_outputs_take_the_lookups_classification_not_the_keys():
    from delvecat_ingest.governance import apply_governance

    st = ent("sourcetype", "fw")
    ip = ent(
        "field",
        "fw/src_ip",
        properties={"field": "src_ip"},
        annotations={"classifications": ["PII.IPAddress"]},
    )
    owner = ent("field", "fw/owner", properties={"field": "owner"})
    manager = ent("field", "fw/manager", properties={"field": "manager"})
    people = ent("lookup", "people", annotations={"classifications": ["PII.Name"]})
    plain = ent("lookup", "teams")
    auto1 = ent("automaticLookup", "LOOKUP-owner")
    auto2 = ent("automaticLookup", "LOOKUP-manager")
    entities = [st, ip, owner, manager, people, plain, auto1, auto2]
    edges = [
        E(st, "contains", ip),
        E(st, "contains", owner),
        E(st, "contains", manager),
        E(auto1, "readsField", ip),
        E(auto1, "definesField", owner),
        E(auto1, "uses", plain),
        E(auto2, "readsField", ip),
        E(auto2, "definesField", manager),
        E(auto2, "uses", people),
    ]
    apply_governance({"entities": entities, "edges": edges})
    assert classes(owner) == {}  # src_ip is only the key
    assert classes(manager)["PII.Name"]["via"] == people["id"]
