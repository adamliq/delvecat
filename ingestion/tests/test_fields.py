from delvecat_ingest.fields import define_fields, link_fields
from delvecat_ingest.lineage import derive


def ent(type_, name, **kw):
    return {
        "id": f"i:{type_}:{name}",
        "type": type_,
        "name": name,
        "product": "splunk",
        "instance": "i",
        **kw,
    }


def ko(type_, name, stanza, **props):
    return ent(type_, f"TA/{stanza} : {name}", properties={"stanza": stanza, **props})


def edges_of(edges, type_):
    return sorted(
        (x["from"].split(":", 2)[2], x["to"].split(":", 2)[2]) for x in edges if x["type"] == type_
    )


def test_define_fields_from_props():
    sampled = ent(
        "field", "acme:fw/src_ip", properties={"sourcetype": "acme:fw", "field": "src_ip"}
    )
    entities = [
        ent("sourcetype", "acme:fw"),
        sampled,
        ko(
            "fieldExtraction",
            "EXTRACT-action",
            "acme:fw",
            kind="Inline",
            value=r"action=(?<action>\w+) port=(?P<dest_port>\d+)",
        ),
        ko("fieldExtraction", "REPORT-kv", "acme:fw", kind="Uses transform", value="acme_kv"),
        ent("transform", "TA/acme_kv", properties={"REGEX": r"(?<vendor>\w+):", "FIELDS": "a, b"}),
        ko("fieldAlias", "FIELDALIAS-src", "acme:fw", aliases={"0.src_ip": "src"}),
        ko(
            "calculatedField",
            "EVAL-bytes",
            "acme:fw",
            field="bytes",
            expression="bytes_in + 'bytes out'",
        ),
        ko(
            "automaticLookup",
            "LOOKUP-owner",
            "acme:fw",
            lookup="asset_owners",
            inputFields={"ip": "src_ip"},
            outputFields={"owner": ""},
        ),
        ko("fieldAlias", "FIELDALIAS-x", "host::fw01", aliases={"0.a": "b"}),  # not a sourcetype
    ]
    edges = define_fields(entities)
    fields = sorted(e["name"] for e in entities if e["type"] == "field")
    assert fields == [
        f"acme:fw/{n}"
        for n in sorted(
            [
                "a",
                "action",
                "b",
                "bytes",
                "bytes out",
                "bytes_in",
                "dest_port",
                "owner",
                "src",
                "src_ip",
                "vendor",
            ]
        )
    ]
    assert sampled in entities and sum(e["id"] == sampled["id"] for e in entities) == 1
    new = next(e for e in entities if e["name"] == "acme:fw/action")
    assert new["displayName"] == "action" and new["properties"]["definedIn"] == "configuration"
    defines = edges_of(edges, "definesField")
    assert ("TA/acme:fw : FIELDALIAS-src", "acme:fw/src") in defines
    assert ("TA/acme:fw : REPORT-kv", "acme:fw/vendor") in defines
    assert ("TA/acme:fw : LOOKUP-owner", "acme:fw/owner") in defines
    assert edges_of(edges, "readsField") == [
        ("TA/acme:fw : EVAL-bytes", "acme:fw/bytes out"),
        ("TA/acme:fw : EVAL-bytes", "acme:fw/bytes_in"),
        ("TA/acme:fw : FIELDALIAS-src", "acme:fw/src_ip"),
        ("TA/acme:fw : LOOKUP-owner", "acme:fw/src_ip"),
    ]
    # New fields hang off their sourcetype like sampled ones.
    assert ("acme:fw", "acme:fw/action") in edges_of(edges, "contains")


def test_link_fields_through_indexes_and_sourcetypes():
    entities = [
        ent("index", "fw"),
        ent("sourcetype", "acme:fw"),
        ent("sourcetype", "acme:vpn"),
        ent("field", "acme:fw/src_ip"),
        ent("field", "acme:vpn/src_ip"),
        ent("field", "acme:vpn/user"),
        ent(
            "savedSearch",
            "TA/by_index",
            properties={"search": "index=fw | stats count by src_ip, user"},
        ),
        ent(
            "savedSearch",
            "TA/by_st",
            properties={"search": "index=fw sourcetype=acme:fw | stats count by src_ip"},
        ),
        ent(
            "savedSearch",
            "TA/lookup",
            properties={"search": "| inputlookup x | stats count by src_ip"},
        ),
    ]
    derive(entities)
    assert entities[6]["lineage"]["fields"]["used"] == [
        {"name": "src_ip", "how": ["groupBy", "output"]},
        {"name": "user", "how": ["groupBy", "output"]},
    ]
    edges = [
        {"from": "i:sourcetype:acme:fw", "to": "i:index:fw", "type": "feeds"},
        {"from": "i:sourcetype:acme:vpn", "to": "i:index:fw", "type": "feeds"},
        {"from": "i:savedSearch:TA/by_index", "to": "i:index:fw", "type": "reads"},
        {"from": "i:savedSearch:TA/by_st", "to": "i:index:fw", "type": "reads"},
        {"from": "i:savedSearch:TA/by_st", "to": "i:sourcetype:acme:fw", "type": "reads"},
    ]
    assert edges_of(link_fields(entities, edges), "readsField") == [
        ("TA/by_index", "acme:fw/src_ip"),
        ("TA/by_index", "acme:vpn/src_ip"),
        ("TA/by_index", "acme:vpn/user"),
        ("TA/by_st", "acme:fw/src_ip"),  # sourcetype= narrows it to one sourcetype
    ]


def test_no_field_lineage_without_fields():
    entities = [ent("savedSearch", "TA/s", properties={"search": "index=fw | head 10"})]
    derive(entities)
    assert "lineage" not in entities[0]


def test_reading_a_classified_field_reads_that_classification():
    from delvecat_ingest.governance import apply_governance

    field = ent("field", "acme:hr/ssn", annotations={"classifications": ["PII"]})
    search = ent("savedSearch", "TA/s")
    other = ent("savedSearch", "TA/t")
    bundle = {
        "entities": [ent("sourcetype", "acme:hr"), field, search, other],
        "edges": [
            {"from": "i:sourcetype:acme:hr", "to": field["id"], "type": "contains"},
            {"from": search["id"], "to": field["id"], "type": "readsField"},
        ],
    }
    apply_governance(bundle)
    assert search["governance"]["readsClassified"] == ["PII"]
    assert "readsClassified" not in other.get("governance", {})
