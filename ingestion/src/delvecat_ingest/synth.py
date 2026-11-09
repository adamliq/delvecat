"""Generate a large, realistic synthetic catalog for performance testing.

The objects are made the way a Splunk extraction makes them (entities, config
edges and SPL held on searches, macros, dashboards and data models), then run
through the real pipeline: ``assemble`` (SPL lineage, the resolver, field
links, health), governance and data quality. Nothing here talks to Splunk.

Scale 1.0 is roughly 100,000 objects: 200 apps, 600 indexes, 1,500
sourcetypes with about 25 fields each, 20,000 hosts, 12,000 saved searches,
2,000 detections, 3,000 dashboards, 5,000 users and the macros, lookups,
eventtypes, tags, data models and props.conf objects that connect them.
Output is deterministic for a given seed and scale.
"""

from __future__ import annotations

import random
import time
from datetime import datetime, timedelta
from typing import Any

from .bundle import assemble
from .compat import UTC
from .governance import apply_governance
from .model import ExtractResult, edge, entity, fqn
from .quality import apply_quality

FIELD_POOL = (  # noqa: SIM905
    "src_ip src dest_ip dest src_port dest_port action user src_user app bytes bytes_in bytes_out "
    "transport protocol rule session_id status http_method uri_path uri_query url http_user_agent "
    "http_referrer signature signature_id severity category process process_name process_id "
    "parent_process_name process_hash command object result vendor_account vendor_region query "
    "query_type reply_code answer file_name file_hash file_path recipient subject message_id "
    "duration response_time EventCode LogName ComputerName Account_Name Logon_Type host_ip mac "
    "vlan dvc interface packets_in packets_out threat_name url_category zone_src zone_dest "
    "device_id tenant_id region account_id event_type outcome reason email phone"
).split()
EXTRA_FIELDS = [f"vendor_field_{i}" for i in range(300)]
PII_FIELDS = {
    "user": "PII.Username",
    "src_user": "PII.Username",
    "src_ip": "PII.IPAddress",
    "email": "PII.Email",
    "phone": "PII.Phone",
    "Account_Name": "PII.Username",
}
CIM_MODELS = {
    "Authentication": "authentication",
    "Network_Traffic": "network",
    "Web": "web",
    "Change": "change",
    "Endpoint": "endpoint",
    "Network_Resolution": "dns",
    "Intrusion_Detection": "ids",
    "Malware": "malware",
    "Email": "email",
}
INST = "big"


def generate(scale: float = 1.0, seed: int = 7) -> tuple[list[dict[str, Any]], ExtractResult]:
    rnd = random.Random(seed)
    n = lambda base: max(1, int(base * scale))  # noqa: E731
    out = ExtractResult()
    ents, edges = out.entities, out.edges
    now = datetime(2026, 11, 7, tzinfo=UTC)
    iso = lambda d: d.isoformat().replace("+00:00", "Z")  # noqa: E731

    apps = [f"app_{i:03d}" for i in range(n(200))]
    for a in apps:
        ents.append(
            entity(
                id=fqn(INST, "app", a),
                type="app",
                name=a,
                instance=INST,
                properties={"author": "Splunk" if a.endswith(("0", "5")) else "acme"},
            )
        )

    def ko(type_: str, name: str, app: str, **props: Any) -> dict[str, Any]:
        e = entity(
            id=fqn(INST, type_, name, app=app, sharing="app"),
            type=type_,
            name=name,
            instance=INST,
            app=app,
            owner="admin",
            sharing=rnd.choice(["app", "global"]),
            properties=props,
        )
        ents.append(e)
        edges.append(edge(fqn(INST, "app", app), e["id"], "contains"))
        return e

    def daily(base: int) -> dict[str, Any]:
        counts = [max(0, int(base * rnd.uniform(0.7, 1.3))) for _ in range(14)]
        if rnd.random() < 0.03:
            counts[-2] = int(base * 0.1)  # a volume drop
        return {"start": (now - timedelta(days=13)).date().isoformat(), "counts": counts}

    indexes = [f"idx_{i:04d}" for i in range(n(600))]
    for name in indexes:
        stale = rnd.random() < 0.02
        last = now - timedelta(days=9 if stale else 0, minutes=rnd.randint(1, 50))
        ents.append(
            entity(
                id=fqn(INST, "index", name),
                type="index",
                name=name,
                instance=INST,
                properties={"datatype": "event"},
                observed={
                    "totalEventCount": rnd.randint(10**3, 10**9),
                    "latestEvent": iso(last),
                    "dailyEvents": daily(rnd.randint(10**3, 10**7)),
                },
            )
        )

    sourcetypes = [f"vendor{i % 120}:product{i}" for i in range(n(1500))]
    st_fields: dict[str, list[str]] = {}
    st_index: dict[str, list[str]] = {}
    for name in sourcetypes:
        sid = fqn(INST, "sourcetype", name)
        ents.append(
            entity(
                id=sid,
                type="sourcetype",
                name=name,
                instance=INST,
                observed={
                    "eventCount": rnd.randint(10**3, 10**8),
                    "lastSeen": iso(now - timedelta(minutes=rnd.randint(1, 120))),
                },
            )
        )
        fields = rnd.sample(FIELD_POOL, rnd.randint(8, 30)) + rnd.sample(
            EXTRA_FIELDS, rnd.randint(0, 6)
        )
        st_fields[name] = fields
        for f in fields:
            fid = fqn(INST, "field", f"{name}/{f}")
            e = entity(
                id=fid,
                type="field",
                name=f"{name}/{f}",
                displayName=f,
                instance=INST,
                properties={
                    "sourcetype": name,
                    "field": f,
                    "numeric": f
                    in (
                        "bytes",
                        "bytes_in",
                        "bytes_out",
                        "dest_port",
                        "src_port",
                        "status",
                        "duration",
                        "EventCode",
                    ),
                },
                observed={
                    "coverage": round(rnd.uniform(0.6, 1.0), 3),
                    "distinctCount": rnd.randint(1, 50000),
                },
            )
            if f in PII_FIELDS and rnd.random() < 0.4:
                e["annotations"] = {"classifications": [PII_FIELDS[f]]}
            ents.append(e)
            edges.append(edge(sid, fid, "contains"))
        st_index[name] = rnd.sample(indexes, rnd.choice([1, 1, 1, 2]))
        for idx in st_index[name]:
            edges.append(edge(sid, fqn(INST, "index", idx), "feeds"))

    for i in range(n(20000)):
        h = f"host-{i:05d}.corp.example"
        ents.append(entity(id=fqn(INST, "host", h), type="host", name=h, instance=INST))
        edges.append(edge(fqn(INST, "host", h), fqn(INST, "index", rnd.choice(indexes)), "feeds"))

    tags = [f"tag_{i}" for i in range(n(300))] + list(CIM_MODELS.values())
    for t in tags:
        ents.append(entity(id=fqn(INST, "tag", t), type="tag", name=t, instance=INST))
    for name in sourcetypes:
        if rnd.random() < 0.4:
            edges.append(
                edge(
                    fqn(INST, "tag", rnd.choice(list(CIM_MODELS.values()))),
                    fqn(INST, "sourcetype", name),
                    "mapsTo",
                )
            )

    for dm, tag in CIM_MODELS.items():
        ko(
            "dataModel",
            dm,
            "Splunk_SA_CIM" if "Splunk_SA_CIM" in apps else apps[0],
            datasets=[
                {
                    "name": dm,
                    "constraint": f"tag={tag}",
                    "fields": [f"{dm}.{f}" for f in rnd.sample(FIELD_POOL, 15)],
                }
            ],
        )

    def search_spl(st: str) -> str:
        idx = st_index[st][0]
        fields = st_fields[st]
        a, b, c = (rnd.sample(fields, 3) if len(fields) >= 3 else fields * 3)[:3]
        spl = f"index={idx} sourcetype={st} {a}=* "
        if rnd.random() < 0.3:
            spl += f"`macro_{rnd.randrange(n(1500))}` "
        spl += f"| eval {a}_l=lower({a}) | stats count dc({b}) as n_{b} by {c}, {a}_l"
        if rnd.random() < 0.3:
            spl += f" | lookup lookup_{rnd.randrange(n(1500))} {c} OUTPUT owner"
        spl += " | where count > 5"
        r = rnd.random()
        if r < 0.1:
            spl += f" | collect index={rnd.choice(indexes)}"
        elif r < 0.2:
            spl += f" | outputlookup lookup_{rnd.randrange(n(1500))}"
        return spl

    for i in range(n(1500)):
        st = rnd.choice(sourcetypes)
        ko(
            "macro",
            f"macro_{i}",
            rnd.choice(apps),
            definition=f"(sourcetype={st} OR index={st_index[st][0]}) "
            f'{rnd.choice(st_fields[st])}!="-"',
        )
    for i in range(n(1500)):
        ko(
            "lookup",
            f"lookup_{i}",
            rnd.choice(apps),
            kind="csv",
            filename=f"lookup_{i}.csv",
            fields=rnd.sample(FIELD_POOL, 4),
        )
    for i in range(n(1000)):
        st = rnd.choice(sourcetypes)
        e = ko(
            "eventtype",
            f"eventtype_{i}",
            rnd.choice(apps),
            search=f"sourcetype={st} {rnd.choice(st_fields[st])}=*",
        )
        edges.append(edge(fqn(INST, "tag", rnd.choice(tags)), e["id"], "mapsTo"))
    for i in range(n(3000)):
        st = rnd.choice(sourcetypes)
        t = rnd.choice(["fieldAlias", "calculatedField", "fieldExtraction"])
        f = rnd.choice(st_fields[st])
        if t == "fieldAlias":
            ko(
                t,
                f"{st} : FIELDALIAS-{i}",
                rnd.choice(apps),
                stanza=st,
                aliases={f"0.{f}": f"{f}_alias"},
            )
        elif t == "calculatedField":
            ko(
                t,
                f"{st} : EVAL-{i}",
                rnd.choice(apps),
                stanza=st,
                field=f"calc_{i % 50}",
                expression=f"lower({f})",
            )
        else:
            ko(
                t,
                f"{st} : EXTRACT-{i}",
                rnd.choice(apps),
                stanza=st,
                kind="Inline",
                value=f"x=(?<extracted_{i % 80}>\\w+)",
            )

    for i in range(n(12000)):
        st = rnd.choice(sourcetypes)
        scheduled = rnd.random() < 0.6
        ko(
            "savedSearch",
            f"Search {i}",
            rnd.choice(apps),
            search=search_spl(st),
            isScheduled=scheduled,
            cronSchedule="*/15 * * * *" if scheduled else None,
        )
    for i in range(n(2000)):
        st = rnd.choice(sourcetypes)
        e = ko(
            "correlationSearch",
            f"Detection {i}",
            rnd.choice(apps),
            search=search_spl(st),
            isScheduled=True,
            cronSchedule="*/5 * * * *",
            severity=rnd.choice(["low", "medium", "high", "critical"]),
        )
        if rnd.random() < 0.05:
            e["disabled"] = True
    for i in range(n(3000)):
        panels = [
            {
                "kind": "inline",
                "id": f"p{j}",
                "title": f"Panel {j}",
                "query": search_spl(rnd.choice(sourcetypes)),
            }
            for j in range(4)
        ]
        ko("dashboard", f"dashboard_{i}", rnd.choice(apps), searches=panels)

    roles = [f"role_{i}" for i in range(n(300))] + ["admin", "user", "power"]
    for r in roles:
        rid = fqn(INST, "role", r)
        ents.append(
            entity(id=rid, type="role", name=r, instance=INST, properties={"srchFilter": "*"})
        )
        for idx in rnd.sample(indexes, min(len(indexes), rnd.randint(1, 30))):
            edges.append(edge(rid, fqn(INST, "index", idx), "grantsAccess"))
    for i in range(n(5000)):
        u = f"user{i:05d}"
        uid = fqn(INST, "user", u)
        ents.append(entity(id=uid, type="user", name=u, instance=INST))
        for r in rnd.sample(roles, rnd.randint(1, 3)):
            edges.append(edge(uid, fqn(INST, "role", r), "memberOf"))

    # Annotations a team would have added: owners, descriptions, domains.
    for e in ents:
        if (
            e["type"] in ("index", "sourcetype", "savedSearch", "correlationSearch", "dashboard")
            and rnd.random() < 0.4
        ):
            ann = e.setdefault("annotations", {})
            ann["owners"] = [f"team-{rnd.randrange(40)}"]
            ann["domain"] = rnd.choice(
                ["Security", "Network", "Web", "Cloud", "Identity", "Infrastructure"]
            )
            if rnd.random() < 0.5:
                ann["description"] = f"Synthetic {e['type']} {e['name']}"

    instances = [{"id": INST, "name": "Synthetic large instance", "kind": "splunkEnterprise"}]
    out.as_of = iso(now)
    return instances, out


def build(scale: float = 1.0, seed: int = 7, log=print) -> dict[str, Any]:
    t0 = time.perf_counter()
    instances, result = generate(scale, seed)
    log(
        f"  generate      {time.perf_counter() - t0:6.1f}s  "
        f"{len(result.entities):,} entities, {len(result.edges):,} edges"
    )
    t = time.perf_counter()
    bundle = assemble(instances, result, generated_at=datetime(2026, 11, 7, tzinfo=UTC))
    log(
        f"  assemble      {time.perf_counter() - t:6.1f}s  "
        f"{len(bundle['entities']):,} entities, {len(bundle['edges']):,} edges"
    )
    bundle["classifications"] = [{"name": "PII", "sensitive": True, "propagate": True}]
    t = time.perf_counter()
    apply_governance(bundle)
    log(f"  governance    {time.perf_counter() - t:6.1f}s")
    t = time.perf_counter()
    apply_quality(bundle)
    log(f"  quality       {time.perf_counter() - t:6.1f}s")
    return bundle
