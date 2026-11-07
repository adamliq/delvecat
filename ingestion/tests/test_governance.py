from delvecat_ingest.governance import apply_governance
from delvecat_ingest.model import entity


def ent(type_, name, **kw):
    ann = kw.pop("classifications", None)
    e = entity(id=f"i:{type_}:{name}", type=type_, name=name, instance="i", **kw)
    if ann:
        e["annotations"] = {"classifications": ann}
    return e


def E(a, t, b):
    return {"from": f"i:{a}", "to": f"i:{b}", "type": t}


def bundle(entities, edges, taxonomy=None):
    b = {"entities": entities, "edges": edges, "ingestionReport": []}
    if taxonomy:
        b["classifications"] = taxonomy
    return b


def gov(b, eid):
    return next(e for e in b["entities"] if e["id"] == eid).get("governance") or {}


def world():
    ents = [
        ent("field", "web/clientip", classifications=["PII.IPAddress"]),
        ent("sourcetype", "web"),
        ent("index", "web"),
        ent("index", "summary"),
        ent("index", "ops"),
        ent("savedSearch", "rollup"),
        ent("dashboard", "board"),
        ent("lookup", "ips", permissions={"read": ["*"]}),
        ent("lookup", "notes", classifications=["Public"], permissions={"read": ["*"]}),
        ent(
            "kvCollection", "vip", classifications=["Confidential"], permissions={"read": ["power"]}
        ),
        ent("role", "user"),
        ent("role", "analyst", properties={"srchFilter": "host=x"}),
        ent("role", "power"),
        ent("role", "admin", properties={"srchFilter": "*"}),
        ent("user", "ana"),
        ent("user", "pat"),
        ent("user", "ada"),
    ]
    edges = [
        E("sourcetype:web", "contains", "field:web/clientip"),
        E("sourcetype:web", "feeds", "index:web"),
        E("savedSearch:rollup", "reads", "index:web"),
        E("savedSearch:rollup", "writes", "index:summary"),
        E("savedSearch:rollup", "writes", "lookup:ips"),
        E("dashboard:board", "reads", "index:web"),
        E("role:analyst", "grantsAccess", "index:web"),
        E("role:user", "grantsAccess", "index:ops"),
        E("role:analyst", "inherits", "role:user"),
        E("role:admin", "inherits", "role:power"),
        E("role:admin", "grantsAccess", "index:summary"),
        E("user:ana", "memberOf", "role:analyst"),
        E("user:pat", "memberOf", "role:user"),
        E("user:ada", "memberOf", "role:admin"),
    ]
    return bundle(
        ents, edges, [{"name": "PII"}, {"name": "Public", "sensitive": False, "propagate": False}]
    )


def test_classifications_follow_structure_and_lineage():
    b = world()
    apply_governance(b)
    st = gov(b, "i:sourcetype:web")["classifications"][0]
    assert (st["name"], st["how"], st["via"]) == ("PII.IPAddress", "field", "i:field:web/clientip")
    idx = gov(b, "i:index:web")["classifications"][0]
    assert (idx["how"], idx["derived"]) == ("sourcetype", False)
    summary = gov(b, "i:index:summary")["classifications"][0]
    assert summary["derived"] is True and summary["how"] == "lineage"
    assert gov(b, "i:lookup:ips")["classifications"][0]["derived"] is True
    assert "classifications" not in gov(b, "i:index:ops")
    assert gov(b, "i:dashboard:board")["readsClassified"] == ["PII.IPAddress"]


def test_who_can_see_sensitive_data():
    b = world()
    summary = apply_governance(b)
    web = gov(b, "i:index:web")["access"]
    assert web["roles"] == ["i:role:analyst"] and web["filteredRoles"] == ["i:role:analyst"]
    assert web["users"] == ["i:user:ana"] and web["everyone"] is False
    ips = gov(b, "i:lookup:ips")["access"]  # derived PII, readable by every role
    assert ips["everyone"] is True and "i:user:pat" in ips["users"]
    vip = gov(b, "i:kvCollection:vip")["access"]  # read: power; admin imports power
    assert vip["roles"] == ["i:role:admin", "i:role:power"] and vip["users"] == ["i:user:ada"]
    assert "access" not in gov(b, "i:lookup:notes")  # Public is not sensitive
    # Users are not given their own copy: the web app unions their roles' reach.
    assert "sensitiveAccess" not in gov(b, "i:user:ada")
    admin = {a["id"]: a for a in gov(b, "i:role:admin")["sensitiveAccess"]}
    assert set(admin) == {"i:index:summary", "i:kvCollection:vip", "i:lookup:ips"}
    assert admin["i:index:summary"]["filtered"] is False  # srchFilter "*" is no filter
    assert summary["exposedToEveryone"] == 1


def test_idempotent():
    b = world()
    apply_governance(b)
    first = [e.get("governance") for e in b["entities"]]
    apply_governance(b)
    assert [e.get("governance") for e in b["entities"]] == first
