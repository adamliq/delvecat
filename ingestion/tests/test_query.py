"""Read-only catalog queries for the REST endpoint."""

import pytest

from delvecat_ingest.query import CatalogIndex, QueryError


def _e(i, t, **kw):
    return {"id": i, "type": t, "name": i.split(":")[-1], "instance": "s1", **kw}


BUNDLE = {
    "entities": [
        _e("s1:sourcetype:fw", "sourcetype"),
        _e("s1:index:net", "index", app="search", health={"status": "warning"}),
        _e("s1:savedSearch:Busy ports", "savedSearch", app="search", owner="ann"),
        _e("s1:dashboard:Network", "dashboard", app="search", annotations={"description": "NOC"}),
    ],
    "edges": [
        {"from": "s1:sourcetype:fw", "to": "s1:index:net", "type": "feeds"},
        {"from": "s1:savedSearch:Busy ports", "to": "s1:index:net", "type": "reads"},
        {"from": "s1:dashboard:Network", "to": "s1:savedSearch:Busy ports", "type": "uses"},
    ],
}


def test_lists_with_filters_and_pages():
    idx = CatalogIndex(BUNDLE)
    r = idx.query({"type": "index,dashboard"})
    assert r["total"] == 2 and [x["type"] for x in r["results"]] == ["index", "dashboard"]
    assert r["results"][0] == {
        "id": "s1:index:net",
        "type": "index",
        "name": "net",
        "instance": "s1",
        "app": "search",
        "health": "warning",
    }
    assert idx.query({"name": "BUSY"})["results"][0]["owner"] == "ann"
    assert (
        idx.query({"app": "search", "limit": "1", "offset": "1"})["results"][0]["name"]
        == "Busy ports"
    )
    assert "properties" not in idx.query({})["results"][0]
    assert idx.query({"fields": "full", "type": "dashboard"})["results"][0]["annotations"]


def test_one_object_with_its_relationships():
    r = CatalogIndex(BUNDLE).query({"id": "s1:index:net"})
    assert r["object"]["name"] == "net"
    assert {x["from"] for x in r["incoming"]} == {"s1:sourcetype:fw", "s1:savedSearch:Busy ports"}
    assert "incoming" not in CatalogIndex(BUNDLE).query(
        {"id": "s1:index:net", "relationships": "0"}
    )


def test_upstream_and_downstream_follow_dependencies():
    idx = CatalogIndex(BUNDLE)
    up = idx.query({"upstream": "s1:dashboard:Network", "depth": "5"})
    assert [(x["name"], x["steps"]) for x in up["results"]] == [
        ("Busy ports", 1),
        ("net", 2),
        ("fw", 3),
    ]
    assert [
        x["name"] for x in idx.query({"upstream": "s1:dashboard:Network", "depth": "2"})["results"]
    ] == [
        "Busy ports",
        "net",
    ]
    down = idx.query({"downstream": "s1:sourcetype:fw", "depth": "10"})
    assert [(x["name"], x["steps"]) for x in down["results"]] == [
        ("net", 1),
        ("Busy ports", 2),
        ("Network", 3),
    ]


@pytest.mark.parametrize(
    "params",
    [
        {"id": "nope"},
        {"limit": "0"},
        {"limit": "5000"},
        {"offset": "-1"},
        {"upstream": "s1:index:net", "depth": "99"},
        {"limit": "x"},
    ],
)
def test_bad_requests_say_why(params):
    with pytest.raises(QueryError):
        CatalogIndex(BUNDLE).query(params)
