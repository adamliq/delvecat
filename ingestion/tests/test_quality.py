from delvecat_ingest.quality import apply_quality


def ent(type_, name, **kw):
    return {
        "id": f"i:{type_}:{name}",
        "type": type_,
        "name": name,
        "product": "splunk",
        "instance": "i",
        **kw,
    }


def field(st, name, coverage=None, distinct=None):
    obs = {k: v for k, v in (("coverage", coverage), ("distinctCount", distinct)) if v is not None}
    return ent(
        "field",
        f"{st}/{name}",
        properties={"field": name, "sourcetype": st, **({"observed": obs} if obs else {})},
    )


def build(st_extra=None, checks=None):
    st = ent(
        "sourcetype",
        "fw",
        properties={"observed": {"lastSeen": "2026-11-07T00:00:00Z"}},
        **(st_extra or {}),
    )
    if checks:
        st["annotations"] = {"qualityChecks": checks}
    idx = ent("index", "fw_idx")
    src = field("fw", "src_ip", coverage=0.99, distinct=40)
    act = field("fw", "action", coverage=0.80, distinct=3)
    cfg = field("fw", "vendor")  # defined in props.conf, not sampled
    det = ent("correlationSearch", "d1")
    entities = [st, idx, src, act, cfg, det]
    edges = [{"from": st["id"], "to": f["id"], "type": "contains"} for f in (src, act, cfg)] + [
        {"from": st["id"], "to": idx["id"], "type": "feeds"},
        {"from": det["id"], "to": src["id"], "type": "readsField"},
        {"from": det["id"], "to": act["id"], "type": "readsField"},
    ]
    bundle = {"entities": entities, "edges": edges}
    counts = apply_quality(bundle)
    return {e["name"]: e for e in entities}, counts


def checks_of(e):
    return {(t["test"], t.get("field")): t for t in e["quality"]["tests"]}


def test_built_in_checks():
    n, counts = build()
    t = checks_of(n["fw"])
    assert t[("fresh", None)]["status"] == "pass"
    assert ("volume", None) not in t  # no daily history yet: left to the Health page
    assert t[("notNull", "src_ip")] == {
        "test": "notNull",
        "field": "src_ip",
        "expectation": "present in at least 95% of events",
        "result": "99% filled",
        "status": "pass",
        "source": "default",
        "why": "read by 1 detection",
    }
    assert t[("notNull", "action")]["status"] == "fail"
    assert n["fw"]["quality"]["failed"] == 1
    assert "quality" not in n["d1"]
    assert counts["objectsChecked"] == 1  # the index has no measurements


def test_health_problems_fail_checks():
    n, _ = build(
        {
            "health": {
                "status": "critical",
                "checks": [
                    {
                        "check": "freshness",
                        "status": "critical",
                        "message": "No new events for 3.0 days",
                    }
                ],
            }
        }
    )
    fresh = checks_of(n["fw"])[("fresh", None)]
    assert (fresh["status"], fresh["result"]) == ("fail", "No new events for 3.0 days")


def test_annotation_checks_override_defaults_and_cover_unsampled_fields():
    n, _ = build(
        checks=[
            {
                "test": "notNull",
                "field": "action",
                "min": 0.5,
                "source": "annotations/acme/x.yaml:4",
            },
            {
                "test": "distinctBetween",
                "field": "action",
                "min": 2,
                "max": 3,
                "source": "annotations/acme/x.yaml:7",
            },
            {"test": "notNull", "field": "vendor", "source": "annotations/acme/x.yaml:10"},
        ]
    )
    t = checks_of(n["fw"])
    assert t[("notNull", "action")]["status"] == "pass" and t[("notNull", "action")][
        "source"
    ].endswith(":4")
    assert t[("distinctBetween", "action")]["result"] == "3 distinct"
    assert t[("notNull", "vendor")]["status"] == "unknown"
    assert n["fw"]["quality"]["failed"] == 0
