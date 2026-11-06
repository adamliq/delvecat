"""Seed the local dev Splunk (deploy/docker-compose.yml) with representative content.

This script WRITES to Splunk and is only meant for the disposable dev container.
DelveCat itself never writes to Splunk.

    SPLUNK_PASSWORD=... uv run --project ingestion python deploy/seed_dev_splunk.py

It also enables token authentication and writes a DelveCat API token to
deploy/.dev-token (git-ignored) for use as DELVECAT_SPLUNK_TOKEN.

Every object it creates is listed in deploy/seed_manifest.json so the
integration test can check that ingestion found all of them.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import httpx

BASE = os.environ.get("SPLUNK_URL", "https://localhost:8089")
AUTH = ("admin", os.environ["SPLUNK_PASSWORD"])
client = httpx.Client(base_url=BASE, auth=AUTH, verify=False, timeout=60)
manifest: list[dict[str, str]] = []


def post(path: str, data: dict | None = None, expect_exists_ok: bool = True) -> None:
    r = client.post(path, data={**(data or {}), "output_mode": "json"})
    if r.status_code == 409 and expect_exists_ok:
        return
    if r.status_code >= 400 and "already exists" in r.text and expect_exists_ok:
        return
    if r.status_code >= 400:
        raise SystemExit(f"POST {path} failed: {r.status_code} {r.text[:400]}")


def ns(app: str, owner: str = "nobody") -> str:
    return f"/servicesNS/{owner}/{app}"


def record(type_: str, name: str, app: str | None = None, owner: str | None = None) -> None:
    """Record a created object; ``owner`` only for private (user-shared) objects."""
    entry = {"type": type_, "name": name}
    if app:
        entry["app"] = app
    if owner:
        entry["owner"] = owner
    manifest.append(entry)


def conf(app: str, file: str, stanza: str, **attrs: str) -> None:
    post(f"{ns(app)}/configs/conf-{file}", {"name": stanza})
    post(f"{ns(app)}/configs/conf-{file}/{_q(stanza)}", attrs)


def _q(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")


def oneshot(app: str, spl: str) -> None:
    r = client.post(f"{ns(app)}/search/jobs", data={
        "search": spl, "exec_mode": "oneshot", "output_mode": "json"})
    r.raise_for_status()


def main() -> None:
    # Apps
    for app, label, desc in [
        ("acme_web", "Acme Web Analytics", "Dashboards and reports for the public storefront."),
        ("acme_secops", "Acme SecOps", "Security monitoring content maintained by the SOC."),
        ("TA-acme-firewall", "Acme Firewall Add-on", "Parsing for perimeter firewall logs."),
    ]:
        post("/services/apps/local", {"name": app, "template": "barebones", "label": label,
                                      "visible": "true", "description": desc})
        record("app", app)

    # Indexes
    for idx, app, extra in [
        ("web", "acme_web", {}),
        ("firewall", "TA-acme-firewall", {"frozenTimePeriodInSecs": "31536000"}),
        ("wineventlog", "acme_secops", {}),
        ("summary_web", "acme_web", {}),
        ("infra_metrics", "search", {"datatype": "metric"}),
    ]:
        post(f"{ns(app)}/data/indexes", {"name": idx, **extra})
        record("index", idx)

    # Sourcetypes and props/transforms knowledge objects
    conf("TA-acme-firewall", "props", "acme:fw",
         SHOULD_LINEMERGE="false", TIME_PREFIX="^", MAX_TIMESTAMP_LOOKAHEAD="25",
         description="Acme perimeter firewall, key=value format", category="Network & Security",
         pulldown_type="1", KV_MODE="auto",
         **{"EXTRACT-action": r"action=(?<action>\w+)",
            "REPORT-fw_kv": "acme_fw_kv",
            "FIELDALIAS-src": "src_ip AS src dest_ip AS dest",
            "EVAL-vendor_product": '"Acme Firewall"',
            "LOOKUP-asset_owner": "asset_owners ip AS src_ip OUTPUT owner"})
    record("sourcetype", "acme:fw")
    record("fieldExtraction", "acme:fw : EXTRACT-action", "TA-acme-firewall")
    record("fieldExtraction", "acme:fw : REPORT-fw_kv", "TA-acme-firewall")
    record("fieldAlias", "acme:fw : FIELDALIAS-src", "TA-acme-firewall")
    record("calculatedField", "acme:fw : EVAL-vendor_product", "TA-acme-firewall")
    record("automaticLookup", "acme:fw : LOOKUP-asset_owner", "TA-acme-firewall")
    conf("TA-acme-firewall", "transforms", "acme_fw_kv", DELIMS='" ", "="', MV_ADD="false")
    record("transform", "acme_fw_kv", "TA-acme-firewall")
    conf("acme_web", "props", "acme:app", SHOULD_LINEMERGE="false",
         description="Storefront application log")
    record("sourcetype", "acme:app")

    # Lookups: CSV file + definition, KV store collection + definition
    oneshot("TA-acme-firewall",
            '| makeresults count=2 | streamstats count | eval ip="10.0.0.".count, owner=if(count=1,"netops","web") '
            "| table ip owner | outputlookup asset_owners.csv")
    client.get(f"{ns('TA-acme-firewall')}/data/lookup-table-files/_reload")  # seed only
    record("lookup", "asset_owners.csv", "TA-acme-firewall")
    conf("TA-acme-firewall", "transforms", "asset_owners", filename="asset_owners.csv")
    record("lookup", "asset_owners", "TA-acme-firewall")
    post(f"{ns('acme_secops')}/storage/collections/config",
         {"name": "threat_hosts", "field.ip": "string", "field.score": "number",
          "accelerated_fields.ip_accel": '{"ip": 1}'})
    record("kvCollection", "threat_hosts", "acme_secops")
    conf("acme_secops", "transforms", "threat_hosts_lookup", external_type="kvstore",
         collection="threat_hosts", fields_list="_key, ip, score")
    record("lookup", "threat_hosts_lookup", "acme_secops")

    # Share TA objects globally so other apps can use them (as real TAs do).
    for path in ("data/transforms/lookups/asset_owners",
                 "data/lookup-table-files/asset_owners.csv"):
        post(f"{ns('TA-acme-firewall')}/{path}/acl", {"sharing": "global", "owner": "nobody"})

    # Macros
    conf("acme_web", "macros", "web_status_buckets",
         definition='eval status_bucket=case(status<300,"2xx",status<400,"3xx",status<500,"4xx",true(),"5xx")',
         description="Groups HTTP status codes.")
    record("macro", "web_status_buckets", "acme_web")
    conf("acme_secops", "macros", "rare_port_threshold(1)", args="min",
         definition="stats count by src_ip, dest_port | where count >= $min$")
    record("macro", "rare_port_threshold(1)", "acme_secops")

    # Eventtypes and tags
    post(f"{ns('acme_secops')}/saved/eventtypes", {
        "name": "acme_failed_login", "search": "index=wineventlog EventCode=4625",
        "description": "Windows failed logons"})
    record("eventtype", "acme_failed_login", "acme_secops")
    conf("acme_secops", "tags", "eventtype=acme_failed_login",
         authentication="enabled", failure="enabled")
    conf("TA-acme-firewall", "tags", "sourcetype=acme:fw", network="enabled", firewall="enabled")
    for t in ("authentication", "failure", "network", "firewall"):
        record("tag", t)

    # Saved searches: scheduled summary, report, alert, private search
    post(f"{ns('acme_web')}/saved/searches", {
        "name": "Web - Hourly Status Summary",
        "search": "index=web sourcetype=access_combined | `web_status_buckets` | stats count by status_bucket, host",
        "description": "Rolls up HTTP status codes per host into summary_web.",
        "is_scheduled": "1", "cron_schedule": "5 * * * *", "dispatch.earliest_time": "-1h@h",
        "dispatch.latest_time": "@h", "actions": "summary_index",
        "action.summary_index": "1", "action.summary_index._name": "summary_web"})
    record("savedSearch", "Web - Hourly Status Summary", "acme_web")
    post(f"{ns('acme_web')}/saved/searches", {
        "name": "Web - Top Error Pages",
        "search": "index=summary_web | stats sum(count) as errors by uri_path | sort - errors | head 20",
        "description": "Feeds the storefront health dashboard.", "dispatch.earliest_time": "-7d"})
    record("savedSearch", "Web - Top Error Pages", "acme_web")
    post(f"{ns('acme_secops')}/saved/searches", {
        "name": "Firewall - Denied Outbound to Rare Ports",
        "search": "index=firewall sourcetype=acme:fw action=blocked NOT dest_port IN (80,443,53) | `rare_port_threshold(5)`",
        "description": "Alerts the SOC when hosts repeatedly hit uncommon ports.",
        "is_scheduled": "1", "cron_schedule": "*/15 * * * *", "dispatch.earliest_time": "-15m",
        "alert_type": "number of events", "alert_comparator": "greater than",
        "alert_threshold": "0", "alert.severity": "4", "actions": "email",
        "action.email.to": "soc@example.com"})
    record("savedSearch", "Firewall - Denied Outbound to Rare Ports", "acme_secops")

    # Roles and users
    post("/services/authorization/roles", {
        "name": "acme_soc", "imported_roles": "user",
        "srchIndexesAllowed": "firewall;wineventlog", "srchIndexesDefault": "firewall",
        "capabilities": "schedule_search"})
    record("role", "acme_soc")
    post("/services/authorization/roles", {
        "name": "acme_web_analyst", "imported_roles": "user", "srchIndexesAllowed": "web*;summary_*"})
    record("role", "acme_web_analyst")
    for user, roles, real in [("jlee", ["acme_soc"], "Jordan Lee"),
                              ("mpatel", ["acme_web_analyst"], "Mira Patel")]:
        post("/services/authentication/users", {
            "name": user, "password": "Dev-only-pass-1234", "roles": roles, "realname": real,
            "email": f"{user}@example.com"})
        record("user", user)
    post(f"{ns('acme_secops', 'jlee')}/saved/searches", {
        "name": "Windows - Failed Logons by User",
        "search": "eventtype=acme_failed_login | stats count by user, src | where count > 20",
        "description": "Ad-hoc investigation helper.", "dispatch.earliest_time": "-4h"})
    record("savedSearch", "Windows - Failed Logons by User", "acme_secops", "jlee")

    # Dashboards (Simple XML and Dashboard Studio)
    post(f"{ns('acme_web')}/data/ui/views", {
        "name": "storefront_health",
        "eai:data": '<dashboard version="1.1"><label>Storefront Health</label><description>Error rates '
                    'and top failing pages for the storefront.</description><row><panel><table>'
                    '<search ref="Web - Top Error Pages"/></table></panel></row></dashboard>'})
    record("dashboard", "storefront_health", "acme_web")
    studio_def = json.dumps({"dataSources": {"ds1": {"type": "ds.search", "options": {
        "query": "index=firewall action=blocked | timechart count"}}},
        "visualizations": {}, "layout": {"type": "absolute", "structure": []}, "title": "SOC Overview"})
    post(f"{ns('acme_secops')}/data/ui/views", {
        "name": "soc_overview",
        "eai:data": f'<dashboard version="2" theme="dark"><label>SOC Overview</label>'
                    f"<definition><![CDATA[{studio_def}]]></definition></dashboard>"})
    record("dashboard", "soc_overview", "acme_secops")

    # Data model
    dm = {"modelName": "Acme_Web", "displayName": "Acme Web", "description": "Storefront traffic",
          "objects": [{"objectName": "Requests", "displayName": "Requests", "parentName": "BaseEvent",
                       "fields": [{"fieldName": "status", "type": "number", "owner": "Requests",
                                   "fieldSearch": "", "required": False, "multivalue": False,
                                   "hidden": False, "editable": True, "displayName": "status",
                                   "comment": ""}],
                       "calculations": [], "constraints": [{"search": "index=web sourcetype=access_combined",
                                                            "owner": "Requests"}],
                       "lineage": "Requests"}],
          "objectNameList": ["Requests"]}
    post(f"{ns('acme_web')}/datamodel/model", {"name": "Acme_Web", "description": json.dumps(dm)})
    record("dataModel", "Acme_Web", "acme_web")

    # Workflow action
    conf("acme_secops", "workflow_actions", "acme_whois", type="link", label="WHOIS $src_ip$",
         fields="src_ip", **{"link.uri": "https://whois.example.com/$src_ip$",
                             "display_location": "both"})
    record("workflowAction", "acme_whois", "acme_secops")

    # Inputs: HEC token, monitor, UDP
    post(f"{ns('splunk_httpinput')}/data/inputs/http/http", {"disabled": "0"})
    post(f"{ns('splunk_httpinput')}/data/inputs/http", {
        "name": "acme_storefront", "index": "web", "indexes": "web,summary_web",
        "sourcetype": "access_combined"})
    record("input", "http://acme_storefront", "splunk_httpinput")
    post(f"{ns('acme_web')}/data/inputs/monitor", {
        "name": "/opt/splunk/var/log/splunk/splunkd-utility.log", "index": "main",
        "sourcetype": "acme:app"})
    record("input", "monitor:///opt/splunk/var/log/splunk/splunkd-utility.log", "acme_web")
    post(f"{ns('TA-acme-firewall')}/data/inputs/udp", {
        "name": "5514", "index": "firewall", "sourcetype": "acme:fw", "connection_host": "ip"})
    record("input", "udp://5514", "TA-acme-firewall")

    # --- Lineage cases (Phase 3): one saved search per SPL pattern -------------------
    def search(app: str, name: str, spl: str, desc: str, owner: str = "nobody") -> None:
        post(f"{ns(app, owner)}/saved/searches", {"name": name, "search": spl,
                                                  "description": desc,
                                                  "dispatch.earliest_time": "-24h"})
        record("savedSearch", name, app, owner if owner != "nobody" else None)

    search("acme_web", "Web - Error Owners",
           "index=web status>=500 | lookup asset_owners ip AS clientip OUTPUT owner "
           "| stats count by owner | outputlookup web_error_owners.csv",
           "Uses a globally shared lookup from the firewall add-on; writes a CSV.")
    search("acme_secops", "Auth - Failures by Tag",
           "tag=authentication tag=failure | stats count by user",
           "Finds data through tags rather than indexes.")
    search("acme_web", "Web - Requests by Status (Data Model)",
           "| tstats count from datamodel=Acme_Web.Requests by Requests.status",
           "Reads the Acme_Web data model.")
    search("acme_secops", "SOC - Blocked Threat Hosts",
           "index=firewall action=blocked [| inputlookup threat_hosts_lookup | rename ip AS src_ip "
           "| fields src_ip] | stats count by src_ip | outputlookup threat_hosts_lookup",
           "Subsearch over a KV store lookup; writes back to it.")
    # Broken references happen when objects are deleted or unshared after a search was
    # saved (Splunk validates macros on save), so recreate that sequence.
    conf("search", "macros", "proxy_filter", definition="search category!=internal")
    search("search", "Legacy - Proxy Categories",
           "index=legacy_proxy | lookup proxy_categories url OUTPUT category | `proxy_filter`",
           "Broken on purpose: the lookup never existed and the macro was deleted.")
    client.delete(f"{ns('search')}/configs/conf-macros/proxy_filter")
    search("acme_web", "Errors Anywhere", "error OR failed | stats count by host",
           "No index: runs against each user's default indexes.")
    conf("acme_secops", "macros", "secops_only_filter", definition="index=wineventlog EventCode=4625")
    macro_acl = f"{ns('acme_secops')}/admin/macros/secops_only_filter/acl"
    post(macro_acl, {"sharing": "global", "owner": "nobody"})
    search("acme_web", "Web - Uses SOC Macro", "`secops_only_filter` | stats count",
           "Broken on purpose: the macro was later restricted to the acme_secops app.")
    post(macro_acl, {"sharing": "app", "owner": "nobody"})
    record("macro", "secops_only_filter", "acme_secops")

    post(f"{ns('acme_web')}/data/ui/views", {
        "name": "web_explorer",
        "eai:data": (
            '<form version="1.1"><label>Web Explorer</label>'
            '<search id="base"><query>index=web sourcetype=access_combined | fields status uri host'
            "</query></search>"
            '<fieldset><input type="dropdown" token="host_tok"><label>Host</label>'
            "<search><query>| tstats count where index=web by host</query></search>"
            '<fieldForLabel>host</fieldForLabel><fieldForValue>host</fieldForValue></input>'
            '<input type="text" token="idx"><label>Index</label><default>web</default></input>'
            "</fieldset>"
            '<row><panel><title>Status codes</title><chart><search base="base">'
            "<query>| stats count by status</query></search></chart></panel>"
            "<panel><title>Any index</title><chart><search>"
            "<query>index=$idx$ | timechart count</query></search></chart></panel>"
            '<panel><title>Owners</title><table><search ref="Web - Error Owners"/></table></panel>'
            "</row></form>"
        )})
    record("dashboard", "web_explorer", "acme_web")

    # Data so that the tstats inventory has something to find
    now = int(time.time())
    batches = [
        ("web", "access_combined", "web01",
         [f'10.0.0.{i} - - [{time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(now - i * 60))}] '
          f'"GET /cart/{i} HTTP/1.1" {200 if i % 5 else 500} 512' for i in range(40)]),
        ("firewall", "acme:fw", "fw-edge-1",
         [f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - i * 30))} action=blocked "
          f"src_ip=10.0.0.{i % 3} dest_ip=203.0.113.{i} dest_port={4000 + i}" for i in range(30)]),
        ("wineventlog", "WinEventLog:Security", "dc01",
         [f"{time.strftime('%m/%d/%Y %I:%M:%S %p', time.gmtime(now - i * 90))} EventCode=4625 "
          f"user=svc{i % 4} src=10.1.0.{i}" for i in range(20)]),
    ]
    for index, st, host, events in batches:
        info = client.get(f"/services/data/indexes/{index}", params={"output_mode": "json"})
        if int(info.json()["entry"][0]["content"].get("totalEventCount", 0) or 0) > 0:
            continue  # already seeded: keep counts stable across re-runs
        r = client.post("/services/receivers/simple",
                        params={"index": index, "sourcetype": st, "host": host},
                        content="\n".join(events).encode())
        r.raise_for_status()

    # API token for DelveCat (token auth is off by default in Splunk Enterprise).
    post("/services/admin/token-auth/tokens_auth", {"disabled": "false"})
    r = client.post("/services/authorization/tokens",
                    data={"name": "admin", "audience": "delvecat", "output_mode": "json"})
    r.raise_for_status()
    token_file = Path(__file__).with_name(".dev-token")
    token_file.write_text(r.json()["entry"][0]["content"]["token"] + "\n")
    token_file.chmod(0o600)

    out = Path(__file__).with_name("seed_manifest.json")
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"seeded {len(manifest)} objects; manifest: {out}")


if __name__ == "__main__":
    main()
