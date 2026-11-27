"""riskTable: the at-risk objects written with every catalog (rules as in web risk.ts)."""

from delvecat_ingest.risk import RULES_VERSION, risk_table


def _e(i, t, **kw):
    return {"id": i, "type": t, "name": i.split(":")[-1], **kw}


def _rows(table):
    """{object: (severity, [(root, depth, via, partial)])} from the compact rows."""
    ids, rows, out, i = table["ids"], table["rows"], {}, 0
    while i < len(rows):
        obj, sev, n = ids[rows[i]], rows[i + 1], rows[i + 2]
        i += 3
        causes = []
        for _ in range(n):
            r, d, v, p = rows[i : i + 4]
            causes.append((ids[r], d, ids[v] if v >= 0 else None, bool(p)))
            i += 4
        out[obj] = (sev, causes)
    return out


def test_dependents_direct_and_through_others():
    crit = {"checks": [{"check": "freshness", "status": "critical", "message": "stale"}]}
    bundle = {
        "entities": [
            _e("i:index:web", "index", health=crit),
            _e("i:savedSearch:s", "savedSearch"),
            _e("i:dashboard:d", "dashboard"),
        ],
        "edges": [
            {"from": "i:savedSearch:s", "to": "i:index:web", "type": "reads"},
            {"from": "i:dashboard:d", "to": "i:savedSearch:s", "type": "uses"},
        ],
    }
    t = risk_table(bundle)
    assert t["version"] == RULES_VERSION
    assert _rows(t) == {
        "i:savedSearch:s": (1, [("i:index:web", 1, None, False)]),
        "i:dashboard:d": (1, [("i:index:web", 2, "i:savedSearch:s", False)]),
    }


def test_one_of_several_producers_is_a_partial_warning_that_stops():
    bad = {"checks": [{"check": "x", "status": "critical", "message": "m"}]}
    bundle = {
        "entities": [
            _e("i:sourcetype:a", "sourcetype", health=bad),
            _e("i:sourcetype:b", "sourcetype"),
            _e("i:index:main", "index"),
            _e("i:savedSearch:s", "savedSearch"),
        ],
        "edges": [
            {"from": "i:sourcetype:a", "to": "i:index:main", "type": "feeds"},
            {"from": "i:sourcetype:b", "to": "i:index:main", "type": "feeds"},
            {"from": "i:savedSearch:s", "to": "i:index:main", "type": "reads"},
        ],
    }
    assert _rows(risk_table(bundle)) == {"i:index:main": (0, [("i:sourcetype:a", 1, None, True)])}


def test_disabled_is_a_cause_but_nothing_runs_through_a_disabled_object():
    bundle = {
        "entities": [
            _e("i:macro:m", "macro", disabled=True),
            _e("i:savedSearch:off", "savedSearch", disabled=True),
            _e("i:savedSearch:on", "savedSearch"),
        ],
        "edges": [
            {"from": "i:savedSearch:off", "to": "i:macro:m", "type": "uses"},
            {"from": "i:savedSearch:on", "to": "i:macro:m", "type": "uses"},
        ],
    }
    assert _rows(risk_table(bundle)) == {"i:savedSearch:on": (0, [("i:macro:m", 1, None, False)])}
