import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DataTable, type Column } from "../components/DataTable";
import { useCatalog } from "../lib/CatalogContext";
import { AckControl, NewBadge, RemedyBox, webUrlOf } from "../components/HealthParts";
import { ackStore, type Ack, type AckState } from "../lib/acks";
import { checkTitle, filterFindings, findings } from "../lib/findings";
import { hasPrevious, items as healthItems, type Item } from "../lib/healthView";
import { IN_SPLUNK, splunkHomeUrl } from "../lib/splunkSource";
import { typeGroup, typeLabel } from "../lib/labels";
import { StatusLabel } from "./HealthPage";

const entityPath = (id: string) => `/entity/${encodeURIComponent(id)}`;

/** Every warning and critical check in the catalog, in one list. */
export function FindingsPage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const store = useMemo(() => ackStore(), []);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => {
    let live = true;
    store.list().then((a) => live && setAcks(a)).catch(() => undefined);
    store.canWrite().then((w) => live && setCanWrite(w)).catch(() => undefined);
    return () => { live = false; };
  }, [store]);
  const save = async (x: Item, state: AckState, days: number | undefined, note: string) => {
    const until = days ? new Date(Date.now() + days * 86400000).toISOString() : undefined;
    const ack = await store.save({ entity: x.entity.id, check: x.check, state, until, status: x.status, note: note || undefined });
    setAcks((a) => [...a.filter((y) => y._key !== ack._key), ack]);
  };
  const remove = async (ack: Ack) => {
    await store.remove(ack._key);
    setAcks((a) => a.filter((y) => y._key !== ack._key));
  };
  const ackMap = useMemo(() => new Map(acks.map((a) => [`${a.entity}\u0000${a.check}`, a])), [acks]);
  const showHandled = params.get("acked") === "1";
  // Same order as findings(): most severe first, then by finding and object.
  const order = useMemo(() => new Map(findings(catalog.entities).map((x, i) => [`${x.entity.id}|${x.check}`, i])), [catalog]);
  const everything = useMemo(
    () => healthItems(catalog.entities, catalog.bundle, ackMap).sort((a, b) => (order.get(`${a.entity.id}|${a.check}`) ?? 0) - (order.get(`${b.entity.id}|${b.check}`) ?? 0)),
    [catalog, ackMap, order],
  );
  const all = useMemo(() => everything.filter((x) => showHandled || !x.handled), [everything, showHandled]);
  const handled = everything.filter((x) => x.handled).length;
  const instanceName = (id: string) => catalog.bundle.instances.find((i) => i.id === id)?.name ?? id;
  const prefix = useMemo(() => splunkHomeUrl().replace(/\/app\/launcher\/home$/, ""), []);
  const f = {
    status: params.get("status") ?? "",
    check: params.get("check") ?? "",
    area: params.get("area") ?? "",
    app: params.get("app") ?? "",
    instance: params.get("instance") ?? "",
    text: params.get("q") ?? "",
  };
  const onlyNew = params.get("new") === "1";
  const shown = useMemo(() => filterFindings(all, f).filter((x) => !onlyNew || x.isNew), [all, f.status, f.check, f.area, f.app, f.instance, f.text, onlyNew]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key: string, value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
  const checks = uniq(all.map((x) => x.check)).sort((a, b) => checkTitle(a).localeCompare(checkTitle(b)));
  const areas = uniq(all.map((x) => typeGroup(x.entity.type)));
  const apps = uniq(all.map((x) => x.entity.app ?? "").filter(Boolean));
  const critical = all.filter((x) => x.status === "critical").length;
  const owner = (x: Item) => x.entity.annotations?.owners?.join(", ") || x.entity.owner || "";

  const columns: Column<Item>[] = [
    { label: "Severity", value: (x) => (x.status === "critical" ? 0 : 1), render: (x) => <StatusLabel status={x.status} /> },
    { label: "Finding", value: (x) => checkTitle(x.check), render: (x) => (
      <>{checkTitle(x.check)}{x.isNew && <> <NewBadge /></>}
        <div><Link className="small" to={`/health?check=${encodeURIComponent(x.check)}&q=${encodeURIComponent(x.entity.displayName ?? x.entity.name)}`}>on the Health page</Link></div></>
    ) },
    {
      label: "Object",
      value: (x) => x.entity.displayName ?? x.entity.name,
      render: (x) => (
        <>
          <span className="muted rel-type">{typeLabel(x.entity.type)}</span>{" "}
          <Link to={entityPath(x.entity.id)}>{x.entity.displayName ?? x.entity.name}</Link>
        </>
      ),
    },
    { label: "Detail", value: (x) => x.message, render: (x) => (
      <>{x.message}
        <RemedyBox item={x} webUrl={webUrlOf(catalog.bundle, x.entity)} inSplunk={IN_SPLUNK} prefix={prefix} />
        <AckControl compact item={x} canWrite={canWrite} onSave={(st, d, n) => save(x, st, d, n)} onRemove={remove} /></>
    ) },
    { label: "App", value: (x) => x.entity.app ?? "" },
    { label: "Owner", value: owner },
    ...(catalog.bundle.instances.length > 1 ? [{ label: "Instance", value: (x: Item) => instanceName(x.entity.instance) }] : []),
  ];

  return (
    <div className="stack">
      <div>
        <div className="title-row">
          <h1>Findings</h1>
          <button type="button" className="btn btn-small" onClick={() => window.print()} title="Print or save as PDF: the findings shown, with how to fix each">Print report</button>
        </div>
        <p className="lede">
          Everything the catalog flagged, most severe first: data and scheduler problems, tokens, alerts, suppressions,
          routing, retention and acceleration. Each finding links to its object and says how to fix it.
          {canWrite ? " Accept or snooze a finding here or on the " : " The "}<Link to="/health">Health page</Link>
          {canWrite ? "." : " groups them by area, owner and app."}
        </p>
      </div>
      <div className="tiles">
        <button type="button" className={`tile${f.status === "critical" ? " active" : ""}`} onClick={() => set("status", f.status === "critical" ? "" : "critical")}>
          <span className="tile-num">{critical}</span><span className="tile-label">critical finding{critical === 1 ? "" : "s"}</span>
        </button>
        <button type="button" className={`tile${f.status === "warning" ? " active" : ""}`} onClick={() => set("status", f.status === "warning" ? "" : "warning")}>
          <span className="tile-num">{all.length - critical}</span><span className="tile-label">warning{all.length - critical === 1 ? "" : "s"}</span>
        </button>
        <div className="tile static" title="Findings shown on this page, and the objects they are on"><span className="tile-num">{new Set(all.map((x) => x.entity.id)).size}</span><span className="tile-label">objects ({all.length.toLocaleString()} finding{all.length === 1 ? "" : "s"})</span></div>
        {hasPrevious(catalog.bundle) && (
          <button type="button" className={`tile${params.get("new") === "1" ? " active" : ""}`} onClick={() => set("new", params.get("new") === "1" ? "" : "1")}>
            <span className="tile-num">{all.filter((x) => x.isNew).length}</span><span className="tile-label">new since the last build</span>
          </button>
        )}
        {handled > 0 && (
          <button type="button" className={`tile${showHandled ? " active" : ""}`} onClick={() => set("acked", showHandled ? "" : "1")} title="Accepted or snoozed">
            <span className="tile-num">{handled}</span><span className="tile-label">acknowledged {showHandled ? "(shown)" : "(hidden)"}</span>
          </button>
        )}
      </div>
      <div className="lineage-controls findings-filters">
        <label className="sort">Finding
          <select value={f.check} onChange={(e) => set("check", e.target.value)}>
            <option value="">All</option>
            {checks.map((c) => <option key={c} value={c}>{checkTitle(c)}</option>)}
          </select>
        </label>
        <label className="sort">Area
          <select value={f.area} onChange={(e) => set("area", e.target.value)}>
            <option value="">All</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="sort">App
          <select value={f.app} onChange={(e) => set("app", e.target.value)}>
            <option value="">All</option>
            {apps.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        {catalog.bundle.instances.length > 1 && (
          <label className="sort">Stack
            <select value={f.instance} onChange={(e) => set("instance", e.target.value)}>
              <option value="">All</option>
              {catalog.bundle.instances.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id}</option>)}
            </select>
          </label>
        )}
        <label className="sort">Contains
          <input type="search" value={f.text} placeholder="text, object or owner" onChange={(e) => set("q", e.target.value)} />
        </label>
      </div>
      <DataTable
        rows={shown}
        columns={columns}
        rowKey={(x) => `${x.entity.id}|${x.check}`}
        csvName="delvecat-findings.csv"
        empty={<p className="muted">{all.length ? "No finding matches these filters." : "Nothing flagged: every object passed its checks."}</p>}
      />
    </div>
  );
}
