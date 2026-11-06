from delvecat_ingest.model import Ref, Target
from delvecat_ingest.resolve import Resolver, splunk_wildcard_match


def ent(type_, name, app=None, sharing=None):
    e = {"id": f"i:{type_}:{app + '/' if app else ''}{name}", "type": type_, "name": name}
    if app:
        e["app"] = app
    if sharing:
        e["sharing"] = sharing
    return e


def test_wildcards_follow_splunk_internal_index_rules():
    assert splunk_wildcard_match("*", "web")
    assert not splunk_wildcard_match("*", "_internal")
    assert splunk_wildcard_match("_*", "_audit")
    assert splunk_wildcard_match("web*", "web_prod")
    assert not splunk_wildcard_match("web*", "summary_web")


def test_pattern_refs_expand_to_every_match():
    r = Resolver([ent("index", n) for n in ("web", "web_prod", "_internal", "fw")])
    edges, unresolved = r.resolve(
        [Ref("i:role:a", Target("index", "web*", pattern=True), "grantsAccess")]
    )
    assert sorted(e["to"] for e in edges) == ["i:index:web", "i:index:web_prod"]
    assert unresolved == []


def test_knowledge_objects_prefer_same_app_then_global():
    entities = [
        ent("transform", "kv", "app_a", "app"),
        ent("transform", "kv", "ta", "global"),
        ent("transform", "kv", "app_c", "app"),
    ]
    r = Resolver(entities)
    assert [e["app"] for e in r.candidates(Target("transform", "kv", "app_a"))] == ["app_a"]
    assert [e["app"] for e in r.candidates(Target("transform", "kv", "other"))] == ["ta"]


def test_reverse_refs_and_unresolved():
    r = Resolver([ent("sourcetype", "acme:fw")])
    edges, unresolved = r.resolve(
        [
            Ref("i:fieldAlias:x", Target("sourcetype", "acme:fw"), "uses", known_is_from=False),
            Ref("i:input:y", Target("index", "missing"), "feeds"),
        ]
    )
    assert edges == [
        {"from": "i:sourcetype:acme:fw", "to": "i:fieldAlias:x", "type": "uses", "origin": "config"}
    ]
    assert [u.target.name for u in unresolved] == ["missing"]
