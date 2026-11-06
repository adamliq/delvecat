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


CONTAINER = os.environ.get("SPLUNK_CONTAINER", "deploy-splunk-1")


def container_file(relative: str, text: str) -> None:
    """Write a file under $SPLUNK_HOME in the dev container (dev seeding only)."""
    import subprocess

    path = f"/opt/splunk/{relative}"
    subprocess.run(
        ["docker", "exec", "-i", "-u", "splunk", CONTAINER, "sh", "-c",
         f'mkdir -p "$(dirname "{path}")" && cat > "{path}"'],
        input=text.encode(), check=True)


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

    # --- Phase 4: Deployment Server, DB Connect, Stream ---------------------------------
    for idx in ("os", "db_orders", "stream"):
        post(f"{ns('search')}/data/indexes", {"name": idx})
        record("index", idx)
    post("/services/data/inputs/tcp/cooked", {"name": "9997"})  # receive from forwarders

    # This instance doubles as a Deployment Server. Apps live in the mounted folder.
    conf("system", "serverclass", "global",
         repositoryLocation="/opt/delvecat-deployment-apps")
    classes = {
        "all_forwarders": ({"whitelist.0": "*"}, ["acme_all_outputs"]),
        "linux_hosts": ({"whitelist.0": "uf-linux-*", "machineTypesFilter": "linux-x86_64"},
                        ["acme_linux_inputs"]),
        "web_servers": ({"whitelist.0": "web-*"}, ["acme_web_inputs"]),
    }
    for name, (attrs, apps) in classes.items():
        conf("system", "serverclass", f"serverClass:{name}", **attrs)
        record("serverClass", name)
        for app in apps:
            conf("system", "serverclass", f"serverClass:{name}:app:{app}",
                 restartSplunkd="true", stateOnClient="enabled")
    for app in ("acme_all_outputs", "acme_linux_inputs", "acme_web_inputs"):
        record("deploymentApp", app)
    client.post("/services/deployment/server/config/_reload")  # seed only

    # DB Connect keeps its configuration in .conf files of its app. Real installs also
    # run a Java service; DelveCat only needs the configuration.
    post("/services/apps/local", {"name": "splunk_app_db_connect", "template": "barebones",
                                  "label": "Splunk DB Connect (dev stand-in)",
                                  "visible": "true"})
    dbx = "splunk_app_db_connect"
    conf(dbx, "identities", "orders_reader", username="splunk_ro", password="dev-only-secret")
    record("dbIdentity", "orders_reader")
    conf(dbx, "db_connections", "orders_mysql", connection_type="mysql",
         host="mysql.internal.example", port="3306", database="shop", identity="orders_reader",
         readonly="true", disabled="0")
    conf(dbx, "db_connections", "legacy_oracle", connection_type="oracle",
         host="ora-legacy.internal.example", port="1521", database="ERP", identity="orders_reader",
         disabled="1")
    for c in ("orders_mysql", "legacy_oracle"):
        record("dbConnection", c)
    conf(dbx, "db_inputs", "orders_rising", connection="orders_mysql", mode="rising",
         query="SELECT order_id, status, amount, updated_at FROM shop.orders "
               "WHERE updated_at > ? ORDER BY updated_at ASC",
         tail_rising_column_name="updated_at", index="db_orders", sourcetype="mysql:orders",
         interval="*/5 * * * *", disabled="0",
         description="New and updated storefront orders.")
    conf(dbx, "db_inputs", "customers_batch", connection="orders_mysql", mode="batch",
         table_name="shop.customers", index="db_orders", sourcetype="mysql:customers",
         interval="0 3 * * *", disabled="1")
    for i in ("orders_rising", "customers_batch"):
        record("dbInput", i)
    conf(dbx, "db_outputs", "fraud_flags_out", connection="orders_mysql",
         table_name="shop.fraud_flags",
         search="index=db_orders sourcetype=mysql:orders amount>100 | table order_id amount",
         interval="0 * * * *", disabled="0")
    record("dbOutput", "fraud_flags_out")
    conf(dbx, "db_lookups", "customer_tier", connection="orders_mysql",
         lookupSQL="SELECT customer_id, tier FROM shop.customers WHERE customer_id = ?",
         input_fields="customer_id", output_fields="tier")
    record("dbLookup", "customer_tier")
    # Splunk checks command names when a search is saved: declare dbxquery like DB Connect.
    conf(dbx, "commands", "dbxquery", filename="dbxquery.py", generating="true",
         supports_rawargs="true")
    post(f"{ns(dbx)}/configs/conf-commands/dbxquery/acl", {"sharing": "global", "owner": "nobody"})
    search("acme_web", "Web - Orders vs Errors",
           '| dbxquery connection="orders_mysql" query="SELECT o.order_id, c.tier FROM '
           'shop.orders o JOIN shop.customers c ON o.customer_id = c.id" '
           "| join order_id [search index=web status>=500]",
           "Joins live order data from MySQL with web errors.")

    # Splunk Stream keeps stream definitions in KV store collections of its app.
    post("/services/apps/local", {"name": "splunk_app_stream", "template": "barebones",
                                  "label": "Splunk Stream (dev stand-in)", "visible": "true"})
    stream_ns = ns("splunk_app_stream")
    for coll in ("streams", "streamforwardergroups"):
        post(f"{stream_ns}/storage/collections/config", {"name": coll})
    streams = [
        {"_key": "http", "id": "http", "protocolName": "http", "enabled": True,
         "index": "stream", "streamType": "event", "category": "Application Layer",
         "description": "HTTP requests seen at the DMZ.",
         "fields": [{"name": f, "enabled": True} for f in ("src_ip", "dest_ip", "uri_path",
                                                          "status")]},
        {"_key": "dns", "id": "dns", "protocolName": "dns", "enabled": True, "index": "stream",
         "streamType": "event", "fields": [{"name": "query", "enabled": True}]},
        {"_key": "smtp", "id": "smtp", "protocolName": "smtp", "enabled": False,
         "index": None, "streamType": "event", "fields": []},
    ]
    groups = [{"_key": "dmz_sensors", "name": "dmz_sensors", "description": "DMZ taps",
               "rule": "streamfwd-dmz-.*", "streams": ["http", "dns", "smtp"]}]
    for coll, docs in (("streams", streams), ("streamforwardergroups", groups)):
        r = client.post(f"{stream_ns}/storage/collections/data/{coll}/batch_save",
                        json=docs, headers={"Content-Type": "application/json"})
        r.raise_for_status()
    for st in ("http", "dns", "smtp"):
        record("streamDefinition", st)
    record("streamGroup", "dmz_sensors")

    # --- Phase 5: Enterprise Security content (stand-in apps; ES itself is conf-based) ----
    for app, label in (("SplunkEnterpriseSecuritySuite", "Enterprise Security (dev stand-in)"),
                       ("SA-ThreatIntelligence", "Threat Intelligence (dev stand-in)"),
                       ("SA-IdentityManagement", "Identity Management (dev stand-in)"),
                       ("DA-ESS-ContentUpdate", "ES Content Update (dev stand-in)"),
                       ("Splunk_SA_CIM", "Common Information Model (dev stand-in)"),
                       ("phantom", "Splunk App for SOAR Export (dev stand-in)")):
        post("/services/apps/local", {"name": app, "template": "barebones", "label": label,
                                      "visible": "true"})
    for idx in ("notable", "risk"):
        post(f"{ns('SA-ThreatIntelligence')}/data/indexes", {"name": idx})
        record("index", idx)
    # Alert actions ES detections use (normally shipped by ES and the SOAR export app).
    # Splunk's REST API cannot create alert actions (apps ship them as files), so the
    # stand-in files are written straight into the dev container.
    by_app: dict[str, list[str]] = {}
    for app, action, label in (("SA-ThreatIntelligence", "notable", "Notable"),
                               ("SA-ThreatIntelligence", "risk", "Risk Analysis"),
                               ("SplunkEnterpriseSecuritySuite", "correlationsearch",
                                "Correlation Search"),
                               ("phantom", "sendtophantom", "Send to SOAR")):
        by_app.setdefault(app, []).append(
            f"[{action}]\nlabel = {label}\ndescription = {label} (dev stand-in)\n"
            "is_custom = 1\npayload_format = json\n")
        record("adaptiveResponseAction", action)
    for app, stanzas in by_app.items():
        container_file(f"etc/apps/{app}/default/alert_actions.conf", "\n".join(stanzas))
        container_file(f"etc/apps/{app}/metadata/default.meta",
                       "[alert_actions]\nexport = system\n\n[savedsearches]\nexport = system\n")
    client.get("/servicesNS/nobody/system/alerts/alert_actions/_reload")  # seed only

    # CIM data models used by detections (constraints by tag, as in the real CIM).
    for name, constraint, dataset in (("Authentication", "tag=authentication", "Authentication"),
                                      ("Network_Traffic", "tag=network tag=communicate",
                                       "All_Traffic")):
        model = {"modelName": name, "displayName": name.replace("_", " "),
                 "description": f"CIM {name} (dev stand-in)",
                 "objects": [{"objectName": dataset, "displayName": dataset,
                              "parentName": "BaseEvent", "fields": [],
                              "calculations": [], "lineage": dataset,
                              "constraints": [{"search": constraint, "owner": dataset}]}],
                 "objectNameList": [dataset]}
        post(f"{ns('Splunk_SA_CIM')}/datamodel/model", {"name": name,
                                                        "description": json.dumps(model)})
        post(f"{ns('Splunk_SA_CIM')}/datamodel/model/{name}/acl",
             {"sharing": "global", "owner": "nobody"})
        record("dataModel", name, "Splunk_SA_CIM")
    conf("acme_secops", "tags", "eventtype=acme_failed_login", authentication="enabled")
    conf("TA-acme-firewall", "tags", "sourcetype=acme:fw", communicate="enabled")
    record("tag", "communicate")

    def detection(app: str, name: str, spl: str, *, mitre: list[str], stories: list[str],
                  domain: str, severity: str, risk: bool = True, soar_label: str | None = None,
                  enabled: bool = True, kill_chain: list[str] | None = None) -> None:
        annotations = {"mitre_attack": mitre, "analytic_story": stories,
                       "kill_chain_phases": kill_chain or [], "cis20": ["CIS 10"],
                       "nist": ["DE.CM"]}
        actions = ["notable"] + (["risk"] if risk else []) + (["sendtophantom"] if soar_label else [])
        attrs = {
            "search": spl, "cron_schedule": "*/30 * * * *", "enableSched": "1",
            "disabled": "0" if enabled else "1",
            "dispatch.earliest_time": "-24h", "dispatch.latest_time": "now",
            "description": f"{name} (dev ES detection).",
            "action.correlationsearch.enabled": "1",
            "action.correlationsearch.label": name,
            "action.correlationsearch.annotations": json.dumps(annotations),
            "action.notable": "1",
            "action.notable.param.rule_title": f"{name} on $src$",
            "action.notable.param.security_domain": domain,
            "action.notable.param.severity": severity,
            "action.notable.param.recommended_actions": "risk,sendtophantom",
            "actions": ",".join(actions),
        }
        if risk:
            attrs["action.risk"] = "1"
            attrs["action.risk.param._risk"] = json.dumps(
                [{"risk_object_field": "src", "risk_object_type": "system", "risk_score": 40}])
        if soar_label:
            attrs["action.sendtophantom"] = "1"
            attrs["action.sendtophantom.param.label"] = soar_label
            attrs["action.sendtophantom.param.sensitivity"] = "amber"
        conf(app, "savedsearches", name, **attrs)
        record("correlationSearch", name, app)

    escu = "DA-ESS-ContentUpdate"
    detection(escu, "ESCU - Brute Force Access Behavior Detected",
              "| tstats count from datamodel=Authentication.Authentication "
              "where Authentication.action=failure by Authentication.src | where count > 10",
              mitre=["T1110", "T1110.001"], stories=["Credential Access via Brute Force"],
              domain="access", severity="high", soar_label="brute_force",
              kill_chain=["Exploitation"])
    detection(escu, "ESCU - Rare Outbound Port Traffic",
              "| tstats count from datamodel=Network_Traffic.All_Traffic "
              "by All_Traffic.src All_Traffic.dest_port | where count < 3",
              mitre=["T1571"], stories=["Command and Control"], domain="network",
              severity="medium", kill_chain=["Command and Control"])
    detection(escu, "ESCU - Suspicious PowerShell Execution",
              "| tstats count from datamodel=Endpoint.Processes "
              'where Processes.process_name="powershell.exe" by Processes.dest',
              mitre=["T1059.001"], stories=["Malicious PowerShell"], domain="endpoint",
              severity="high", soar_label="malware")  # no Endpoint data model: blind
    detection("SplunkEnterpriseSecuritySuite", "Access - Excessive Failed Logins - Rule",
              "index=wineventlog EventCode=4625 | stats count by src user | where count > 20",
              mitre=["T1110.003"], stories=["Credential Access via Brute Force"],
              domain="access", severity="medium", enabled=False)
    conf(escu, "analyticstories", "Credential Access via Brute Force",
         category="Adversary Tactics", description="Detect password guessing and spraying.",
         narrative="Attackers guess passwords against exposed services.")
    conf(escu, "analyticstories", "Command and Control", category="Adversary Tactics",
         description="Detect hosts talking to command and control infrastructure.")
    for story in ("Credential Access via Brute Force", "Command and Control",
                  "Malicious PowerShell"):
        record("analyticStory", story)

    # Threat intelligence and asset/identity sources are modular inputs in ES.
    conf("SA-ThreatIntelligence", "inputs", "threatlist://acme_blocklist",
         description="Internal IP blocklist", type="threatlist", weight="60",
         url="https://intel.example.com/blocklist.csv", interval="43200", disabled="0")
    conf("SA-ThreatIntelligence", "inputs", "threatlist://open_phish",
         description="Phishing URLs", type="threatlist", weight="40",
         url="https://user:secret@feeds.example.org/phish.csv", interval="86400", disabled="1")
    record("threatIntelSource", "acme_blocklist")
    record("threatIntelSource", "open_phish")
    conf("SA-IdentityManagement", "inputs", "identity_manager://acme_assets",
         description="Asset owners from the firewall add-on", category="asset",
         target="asset", url="lookup://asset_owners", disabled="0")
    record("assetIdentitySource", "acme_assets")

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
    batches += [
        ("db_orders", "mysql:orders", "dbx-hf-01",
         [f"{time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(now - i * 120))} order_id={1000 + i} "
          f"status={'shipped' if i % 3 else 'pending'} amount={10 + i}" for i in range(15)]),
        ("stream", "stream:http", "streamfwd-dmz-01",
         [f'{{"timestamp":"{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - i * 45))}",'
          f'"src_ip":"198.51.100.{i}","dest_ip":"10.0.0.5","uri_path":"/cart/{i}","status":200}}'
          for i in range(12)]),
        ("stream", "stream:dns", "streamfwd-dmz-01",
         [f'{{"timestamp":"{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - i * 50))}",'
          f'"src_ip":"10.0.0.{i}","query":"host{i}.example.com","reply_code":"NoError"}}'
          for i in range(10)]),
    ]
    for index, st, host, events in batches:
        existing = client.post("/services/search/jobs", data={
            "search": f'| tstats count where index="{index}" sourcetype="{st}"',
            "exec_mode": "oneshot", "output_mode": "json", "earliest_time": "0"})
        rows = existing.json().get("results") or [{}]
        if int(rows[0].get("count", 0) or 0) > 0:
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
