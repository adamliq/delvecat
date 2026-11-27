"""Two-tier deployment servers: a second-tier server takes apps from an upstream one."""

from __future__ import annotations

from datetime import datetime, timezone

from delvecat_ingest.bundle import assemble
from delvecat_ingest.connectors import deployment_server
from delvecat_ingest.merge import merge_bundles
from delvecat_ingest.transport import EndpointNotFound

NOW = datetime(2026, 11, 25, 20, 20, tzinfo=timezone.utc)
T1_GUID = "578BE251-7E32-4F59-A9EB-D61A4421A0E4"
T2_GUID = "AEB381EE-0BA5-43C3-A5E9-F651A95DD8A5"
FW_GUID = "E8EE4194-7ADE-4D9F-9378-95E59ADAAAAE"
SC = "/servicesNS/nobody/system/configs/conf-serverclass"


class Mem:
    """Answers REST paths from a dict; anything else is not found."""

    def __init__(self, routes):
        self.routes = routes

    def get(self, path, params=None):
        if path not in self.routes:
            raise EndpointNotFound(path)
        return {"entry": [{"name": n, "content": c, "acl": {}} for n, c in self.routes[path]]}


def _app(result, classes, state="enabled", reason=None):
    v = {"result": "Fail" if reason else "Ok", "serverclasses": classes, "stateOnClient": state}
    if reason:
        v["failedReason"] = f"'{reason}'"
    return v


def _client(name, guid, classes, apps, last):
    return (
        guid,
        {
            "hostname": name,
            "guid": guid,
            "utsname": "linux-x86_64",
            "serverClasses": {c: {} for c in classes},
            "applications": apps,
            "lastPhoneHomeTime": last,
        },
    )


FAIL = (
    "Failed to install app=/opt/splunk/etc/deployment-apps/uf_base; "
    "reason=Application does not exist"
)
TIER1 = {
    "/services/server/info": [("server-info", {"serverName": "ds", "guid": T1_GUID})],
    "/services/deployment/server/serverclasses": [
        ("all_forwarders", {"whitelist.0": "*"}),
        ("emea_relay", {"whitelist.0": "ds-emea*", "stateOnClient": "noop"}),
    ],
    SC: [
        ("global", {"restartSplunkd": "false"}),
        ("serverClass:all_forwarders", {"whitelist.0": "*"}),
        ("serverClass:all_forwarders:app:uf_base", {"restartSplunkd": "true"}),
        ("serverClass:emea_relay", {"stateOnClient": "noop"}),
        ("serverClass:emea_relay:app:uf_base", {}),
        ("serverClass:emea_relay:app:fw_inputs", {}),
    ],
    "/services/deployment/server/applications": [
        ("uf_base", {"serverclasses": ["all_forwarders", "emea_relay"]}),
        ("fw_inputs", {"serverclasses": ["emea_relay"]}),
    ],
    "/services/deployment/server/clients": [
        _client(
            "ds-emea",
            T2_GUID,
            ["all_forwarders", "emea_relay"],
            {
                "uf_base": _app(None, ["all_forwarders", "emea_relay"], reason=FAIL),
                "fw_inputs": _app(None, ["emea_relay"], state="noop"),
            },
            1795637627,
        ),
        # fw01 phoned home here before it moved to ds-emea
        _client(
            "fw01",
            FW_GUID,
            ["all_forwarders"],
            {"uf_base": _app(None, ["all_forwarders"])},
            1795630000,
        ),
    ],
    "/services/deployment/client": [("config", {"disabled": True})],
}
TIER2 = {
    "/services/server/info": [("server-info", {"serverName": "ds-emea", "guid": T2_GUID})],
    "/services/deployment/server/serverclasses": [("emea_fw", {"whitelist.0": "fw*"})],
    SC: [
        ("serverClass:emea_fw", {"whitelist.0": "fw*"}),
        ("serverClass:emea_fw:app:fw_inputs", {}),
        ("serverClass:emea_fw:app:emea_local", {}),
    ],
    "/services/deployment/server/applications": [
        ("uf_base", {"serverclasses": []}),
        ("fw_inputs", {"serverclasses": ["emea_fw"]}),
        ("emea_local", {"serverclasses": ["emea_fw"]}),
    ],
    "/services/deployment/server/clients": [
        _client("fw01", FW_GUID, ["emea_fw"], {"fw_inputs": _app(None, ["emea_fw"])}, 1795637600),
    ],
    "/services/deployment/client": [
        (
            "config",
            {
                "disabled": False,
                "targetUri": "ds:8089",
                "clientName": "ds-emea",
                "serverClasses": ["emea_relay:uf_base", "emea_relay:fw_inputs"],
            },
        )
    ],
    "/servicesNS/nobody/system/configs/conf-deploymentclient": [
        (
            "deployment-client",
            {
                "repositoryLocation": "$SPLUNK_HOME/etc/deployment-apps",
                "serverRepositoryLocationPolicy": "rejectAlways",
            },
        ),
        ("target-broker:deploymentServer", {"targetUri": "ds:8089"}),
    ],
}


def _build(routes, instance):
    t = Mem(routes)
    r = deployment_server.extract(t, instance)
    info = routes["/services/server/info"][0][1]
    props = {**info, **(r.instance_facts.get("properties") or {})}
    inst = {"id": instance, "name": instance, "kind": "splunkEnterprise", "properties": props}
    return assemble([inst], r, NOW)


def _by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def test_second_tier_records_its_upstream_and_app_origin():
    b = _build(TIER2, "emea")
    conf = b["instances"][0]["properties"]["deploymentClient"]
    assert conf["upstream"] == "ds:8089"
    assert conf["relaysApps"] is True
    assert conf["receivedApps"] == ["fw_inputs", "uf_base"]
    ents = _by_id(b)
    assert ents["emea:deploymentApp:fw_inputs"]["properties"]["origin"] == "upstream"
    assert ents["emea:deploymentApp:emea_local"]["properties"]["origin"] == "local"


def test_top_tier_has_no_client_config_and_keeps_class_app_settings():
    b = _build(TIER1, "top")
    assert "deploymentClient" not in b["instances"][0]["properties"]
    sc = _by_id(b)["top:serverClass:all_forwarders"]["properties"]["appSettings"]
    assert sc == {"uf_base": {"restartSplunkd": True, "stateOnClient": "enabled"}}
    relay = _by_id(b)["top:serverClass:emea_relay"]["properties"]["appSettings"]
    assert relay["fw_inputs"] == {"restartSplunkd": False, "stateOnClient": "noop"}
    client = _by_id(b)["top:deploymentClient:ds-emea"]
    failure = client["properties"]["observed"]["appFailures"]["uf_base"]
    assert "Application does not exist" in failure["reason"]
    assert failure["serverClasses"] == ["all_forwarders", "emea_relay"]
    assert "Application does not exist" in client["health"]["checks"][0]["message"]


def test_merge_joins_the_tiers():
    merged = merge_bundles([("t1", _build(TIER1, "top")), ("t2", _build(TIER2, "emea"))], NOW)
    inst = {i["id"]: i["properties"] for i in merged["instances"]}
    assert inst["top"]["deploymentTier"] == 1
    assert inst["emea"]["deploymentTier"] == 2
    assert inst["emea"]["deploymentClient"]["upstreamInstance"] == "top"
    ents = _by_id(merged)
    ds = ents["top:deploymentClient:ds-emea"]
    assert ds["properties"]["deploymentServerInstance"] == "emea"
    edges = {(e["from"], e["to"]) for e in merged["edges"] if e["type"] == "deploys"}
    assert ("top:deploymentApp:fw_inputs", "emea:deploymentApp:fw_inputs") in edges
    # enabling failed, but the app still reached the downstream deployment-apps folder
    assert ("top:deploymentApp:uf_base", "emea:deploymentApp:uf_base") in edges
    assert ents["emea:deploymentApp:fw_inputs"]["properties"]["receivedFrom"] == (
        "top:deploymentApp:fw_inputs"
    )
    assert ents["emea:deploymentApp:emea_local"]["properties"]["origin"] == "local"
    relay = [c for c in ds["health"]["checks"] if c["check"] == "relay"]
    assert relay and "all_forwarders: uf_base" in relay[0]["message"]
    assert "emea_relay" not in relay[0]["message"]
    report = next(r for r in merged["ingestionReport"] if r["connector"] == "merge")
    assert report["counts"]["deploymentTierLinks"] == 2


def test_moved_forwarder_is_not_reported_as_silent():
    merged = merge_bundles([("t1", _build(TIER1, "top")), ("t2", _build(TIER2, "emea"))], NOW)
    ents = _by_id(merged)
    old = ents["top:deploymentClient:fw01"]
    assert old["properties"]["movedTo"] == "emea"
    assert not any(c["check"] == "phoneHome" for c in (old.get("health") or {}).get("checks", []))
    assert "movedTo" not in ents["emea:deploymentClient:fw01"]["properties"]


def test_upstream_alone_still_explains_the_failed_install():
    b = _build(TIER1, "top")
    msg = _by_id(b)["top:deploymentClient:ds-emea"]["health"]["checks"][0]["message"]
    assert msg.startswith("Apps not installed: uf_base (Failed to install")


def test_unused_app_is_flagged_and_versions_are_read(tmp_path):
    routes = {k: list(v) for k, v in TIER1.items()}
    routes["/services/deployment/server/applications"] = [
        *routes["/services/deployment/server/applications"],
        ("retired", {"serverclasses": []}),
    ]
    app = tmp_path / "uf_base" / "default"
    app.mkdir(parents=True)
    (app / "app.conf").write_text("[launcher]\nversion = 1.4.0\n\n[ui]\nlabel = ACME UF base\n")
    (tmp_path / "retired" / "default").mkdir(parents=True)
    r = deployment_server.extract(Mem(routes), "top", tmp_path)
    inst = {"id": "top", "name": "top", "kind": "splunkEnterprise"}
    b = assemble([inst], r, NOW)
    ents = _by_id(b)
    base = ents["top:deploymentApp:uf_base"]
    assert base["properties"]["version"] == "1.4.0" and base.get("displayName") == "ACME UF base"
    assert base["properties"]["serverClassCount"] == 2 and base["properties"]["clientCount"] == 2
    assert "deploymentAppUnused" not in str(base.get("health"))
    retired = ents["top:deploymentApp:retired"]
    checks = {c["check"]: c["message"] for c in retired["health"]["checks"]}
    assert checks["deploymentAppUnused"].startswith("In no server class and on no client")
