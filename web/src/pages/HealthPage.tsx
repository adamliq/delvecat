import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flag, useUrlState } from "../lib/urlState";
import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { AckControl, CheckBars, HealthTrend, NewBadge, RemedyBox, webUrlOf } from "../components/HealthParts";
import { Sparkline } from "../components/Sparkline";
import type { Entity, EntityType } from "../generated/catalog";
import { ackStore, type Ack, type AckState } from "../lib/acks";
import { useCatalog } from "../lib/CatalogContext";
import { checkTitle } from "../lib/findings";
import { dailySeries, downloadText, isBuiltin, isUnused, measuredAt, toCsv } from "../lib/health";
import {
  SECTIONS, ago, alertSeries, builtinApps, checkCounts, CLEANUP_TYPES, DEPENDENT_EDGES, filterItems, groupRows, hasPrevious,
  items as allItems, objectRows, ownerOf, problemSeries, reclaimableMB, sizeText, thresholdText, type Filters, type Item,
} from "../lib/healthView";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { riskMap } from "../lib/risk";
import { entityPath } from "../lib/routes";
import { IN_SPLUNK, splunkHomeUrl } from "../lib/splunkSource";

const ICON = { critical: "✕", warning: "!", ok: "✓" } as const;

/** "as of 2026-11-06T05:43:46Z" → "Measured as of 06/11/2026, 05:43." in the reader's locale. */
function asOf(message?: string): string {
  const iso = message?.replace(/^as of /, "");
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `Measured as of ${d.toLocaleString()}.` : "";
}

export function StatusLabel({ status }: { status: "ok" | "warning" | "critical" }) {
  const cls = status === "ok" ? "status-good" : status === "warning" ? "status-warning" : "status-critical";
  return <span className={`status-label ${cls}`}>{ICON[status]} {status === "ok" ? "OK" : status === "warning" ? "Warning" : "Critical"}</span>;
}

function ObjectCell({ e }: { e: Entity }) {
  return (
    <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>
      {e.app && <div className="muted small">{e.app}</div>}</>
  );
}

/** The daily series that fits a section: events for data, problem runs or fires for searches. */
function Trend({ e, section }: { e: Entity; section: string }) {
  if (section === "data") {
    const s = dailySeries(e);
    return s ? <Sparkline series={s} label={`Daily events for ${e.name}`} /> : <>—</>;
  }
  if (section === "searches") {
    const p = problemSeries(e);
    const a = alertSeries(e);
    if (!p && !a) return <>—</>;
    return (
      <div className="stack-tight">
        {p && <div><Sparkline series={p} unit="skipped or failed runs" label={`Skipped or failed runs per day for ${e.name}`} /> <span className="muted small">skipped/failed</span></div>}
        {a && <div><Sparkline series={a} unit="alerts fired" label={`Alerts fired per day for ${e.name}`} /> <span className="muted small">fired</span></div>}
      </div>
    );
  }
  return <>—</>;
}

const HEALTH_CSV = ["type", "name", "app", "owner", "check", "status", "message", "first seen", "new", "acknowledged", "id"];
const csvRows = (list: Item[]) => list.map((x) => [
  x.entity.type, x.entity.name, x.entity.app, ownerOf(x.entity), checkTitle(x.check), x.status, x.message, x.since,
  x.isNew ? "yes" : "", x.ack ? `${x.ack.state}${x.ack.until ? ` until ${x.ack.until}` : ""}` : "", x.entity.id,
]);

function AtRisk() {
  const { catalog } = useCatalog();
  const rows = [...riskMap(catalog)].map(([id, risk]) => ({ entity: catalog.byId.get(id)!, risk }))
    .filter((r) => r.entity)
    .sort((a, b) => (a.risk.severity === b.risk.severity ? 0 : a.risk.severity === "critical" ? -1 : 1)
      || a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
  const exportCsv = () => downloadText("delvecat-at-risk.csv", toCsv([
    ["type", "name", "app", "risk", "caused by", "problem", "hops", "via", "partly affected", "id"],
    ...rows.flatMap(({ entity: e, risk }) => risk.causes.map((c) => [
      e.type, e.name, e.app, risk.severity, c.root.id, c.problems.map((p) => p.summary).join("; "), c.depth, c.via?.id,
      c.partial ? "yes" : "no", e.id,
    ])),
  ]));
  return (
    <section id="at-risk">
      <div className="results-bar">
        <h2>At risk from upstream problems <span className="muted">({rows.length})</span></h2>
        <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!rows.length}>Download CSV</button>
      </div>
      <p className="muted small">
        Objects that depend, directly or through other objects, on something with a health finding, a broken reference or
        a disabled object. When something has several sources, one bad source only partly affects it.
      </p>
      <DataTable
        rows={rows}
        rowKey={(r) => r.entity.id}
        empty={<p className="muted">Nothing depends on an object with a problem.</p>}
        columns={[
          { label: "Object", value: ({ entity: e }) => e.displayName ?? e.name, render: ({ entity: e }) => <ObjectCell e={e} /> },
          { label: "Risk", value: ({ risk }) => (risk.severity === "critical" ? 0 : 1), render: ({ risk }) => <StatusLabel status={risk.severity} /> },
          { label: "Caused by", value: ({ risk }) => risk.causes.map((c) => c.root.displayName ?? c.root.name).join("; "), render: ({ risk }) => risk.causes.map((c) => (
            <div key={c.root.id}>
              <Link to={entityPath(c.root.id)}>{c.root.displayName ?? c.root.name}</Link>: {c.problems.map((p) => p.summary).join("; ")}
              <span className="muted small"> · {c.depth === 1 ? "direct" : `${c.depth} hops`}{c.partial ? " · partly" : ""}</span>
            </div>
          )) },
        ]}
      />
    </section>
  );
}

function Cleanup() {
  const { catalog } = useCatalog();
  const [params, update] = useUrlState();
  const builtin = flag(params, "builtin");
  const disabled = flag(params, "disabled");
  const type = params.get("ctype") ?? "";
  const safeOnly = flag(params, "safe");
  const setBuiltin = (v: boolean) => update({ builtin: v });
  const setDisabled = (v: boolean) => update({ disabled: v });
  const setType = (v: string) => update({ ctype: v });
  const setSafeOnly = (v: boolean) => update({ safe: v });
  const vendorApps = useMemo(() => builtinApps(catalog.entities), [catalog]);
  const asOf = new Date(measuredAt(catalog.bundle));
  const dependents = useCallback(
    (e: Entity) => catalog.edgesTo(e.id).filter((x) => DEPENDENT_EDGES.has(x.type) && x.from !== e.id).length,
    [catalog],
  );
  const candidates = useMemo(() => {
    const unused = catalog.entities.filter(isUnused).map((e) => ({ e, why: e.usage?.reason ?? "", builtin: isBuiltin(e) }));
    const off = disabled
      ? catalog.entities
        .filter((e) => e.disabled && CLEANUP_TYPES.has(e.type) && !isUnused(e))
        .map((e) => ({ e, why: "Disabled", builtin: !!e.app && vendorApps.has(e.app) }))
      : [];
    return [...unused, ...off].map((r) => ({ ...r, deps: dependents(r.e), mb: reclaimableMB(r.e) }));
  }, [catalog, disabled, vendorApps, dependents]);
  const shown = candidates.filter((r) => builtin || !r.builtin);
  const rows = shown
    .filter((r) => (!type || r.e.type === type) && (!safeOnly || r.deps === 0))
    .sort((a, b) => a.e.type.localeCompare(b.e.type) || a.e.name.localeCompare(b.e.name));
  const types = [...new Set(shown.map((r) => r.e.type))].sort();
  const freed = rows.reduce((n, r) => n + (r.mb ?? 0), 0);
  const exportCsv = () => downloadText("delvecat-unused-objects.csv", toCsv([
    ["type", "name", "app", "owner", "reason", "last used", "last changed", "size MB", "dependents", "built-in", "id"],
    ...rows.map(({ e, why, deps, mb, builtin: b }) => [e.type, e.name, e.app, e.owner, why, e.usage?.lastUsed, e.updatedAt, mb, deps, b ? "yes" : "no", e.id]),
  ]));
  return (
    <section id="cleanup">
      <div className="results-bar">
        <h2>Cleanup: unused objects <span className="muted">({rows.length})</span></h2>
        <div className="lineage-controls">
          <label className="sort">
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {types.map((t) => <option key={t} value={t}>{pluralTypeLabel(t as EntityType)}</option>)}
            </select>
          </label>
          <label className="sort"><input type="checkbox" checked={safeOnly} onChange={(e) => setSafeOnly(e.target.checked)} /> Only ones nothing refers to</label>
          <label className="sort"><input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> Include disabled objects</label>
          <label className="sort"><input type="checkbox" checked={builtin} onChange={(e) => setBuiltin(e.target.checked)} /> Include Splunk built-in apps</label>
          <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!rows.length}>Download CSV</button>
        </div>
      </div>
      <p className="muted small">
        Judged from the usage window of audit, scheduler and web logs, plus lineage: an object is unused when nothing in the
        catalog depends on it and no one ran, viewed or referenced it. Review before deleting anything.
        {freed > 0 && <> Removing the unused indexes listed would free about <strong>{sizeText(freed)}</strong>.</>}
      </p>
      <DataTable
        rows={rows}
        rowKey={(r) => r.e.id}
        empty={<p className="muted">Nothing unused{builtin ? "" : " in custom apps"}.</p>}
        columns={[
          { label: "Object", value: ({ e }) => e.displayName ?? e.name, render: ({ e }) => (
            <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>{e.disabled && <span className="muted small"> (disabled)</span>}</>
          ) },
          { label: "App", value: ({ e }) => e.app ?? "", render: ({ e, builtin: b }) => <>{e.app ?? "—"}{b && <span className="muted small"> (built-in)</span>}</> },
          { label: "Owner", value: ({ e }) => ownerOf(e), render: ({ e }) => ownerOf(e) || <span className="muted">—</span> },
          { label: "Last used", value: ({ e }) => e.usage?.lastUsed ?? "", render: ({ e }) => (e.usage?.lastUsed ? <span title={new Date(e.usage.lastUsed).toLocaleString()}>{ago(e.usage.lastUsed, asOf)}</span> : <span className="muted">not in the window</span>) },
          { label: "Last changed", value: ({ e }) => e.updatedAt ?? "", render: ({ e }) => (e.updatedAt ? <span title={new Date(e.updatedAt).toLocaleString()}>{ago(e.updatedAt, asOf)}</span> : <span className="muted">—</span>) },
          { label: "Size", value: ({ mb }) => mb ?? -1, render: ({ mb }) => (mb ? sizeText(mb) : <span className="muted">—</span>) },
          { label: "Refers to it", value: ({ deps }) => deps, render: ({ deps }) => (deps === 0 ? <span className="safe-hint" title="No object in the catalog uses, reads or feeds it">nothing (safe to remove)</span> : <>{deps} object{deps === 1 ? "" : "s"}</>) },
          { label: "Why", value: ({ why }) => why },
        ]}
      />
    </section>
  );
}

type View = "objects" | "owners" | "apps";

export function HealthPage() {
  const { catalog } = useCatalog();
  const bundle = catalog.bundle;
  const report = bundle.ingestionReport?.find((r) => r.connector === "health");
  const store = useMemo(() => ackStore(), []);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [params, update] = useUrlState();
  const filters: Filters = useMemo(() => ({
    status: (params.get("status") ?? "") as Filters["status"],
    section: params.get("area") ?? undefined,
    check: params.get("check") ?? undefined,
    owner: params.get("owner") ?? undefined,
    app: params.get("app") ?? undefined,
    text: params.get("q") ?? undefined,
    onlyNew: flag(params, "new"),
    showHandled: flag(params, "acked"),
  }), [params]);
  const view: View = (["owners", "apps"] as View[]).includes(params.get("view") as View) ? (params.get("view") as View) : "objects";
  const KEYS: Record<keyof Filters, string> = { status: "status", section: "area", check: "check", owner: "owner", app: "app", text: "q", onlyNew: "new", showHandled: "acked" };
  const toParams = (f: Partial<Filters>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [KEYS[k as keyof Filters], v]));
  // Replaces the findings filters only (the cleanup report keeps its own).
  const setFilters = (f: Filters, v: View = view) =>
    update({ ...Object.fromEntries(Object.values(KEYS).map((k) => [k, undefined])), ...toParams(f), view: v === "objects" ? undefined : v });
  const setView = (v: View) => update({ view: v === "objects" ? undefined : v });
  const listTop = useRef<HTMLDivElement>(null);
  const prefix = useMemo(() => splunkHomeUrl().replace(/\/app\/launcher\/home$/, ""), []);

  useEffect(() => {
    let live = true;
    store.list().then((a) => live && setAcks(a)).catch(() => undefined);
    store.canWrite().then((w) => live && setCanWrite(w)).catch(() => undefined);
    return () => { live = false; };
  }, [store]);

  const ackMap = useMemo(() => new Map(acks.map((a) => [`${a.entity}\u0000${a.check}`, a])), [acks]);
  const all = useMemo(() => allItems(catalog.entities, bundle, ackMap), [catalog, bundle, ackMap]);
  const open = useMemo(() => all.filter((x) => !x.handled), [all]);
  const list = useMemo(() => filterItems(all, filters), [all, filters]);
  const counts = useMemo(() => checkCounts(filterItems(all, { ...filters, check: undefined })), [all, filters]);
  const compare = hasPrevious(bundle);
  const resolved = bundle.resolvedFindings ?? [];
  const unusedCustom = catalog.entities.filter((e) => isUnused(e) && !isBuiltin(e)).length;
  const atRisk = useMemo(() => riskMap(catalog).size, [catalog]);

  const owners = useMemo(() => [...new Set(all.map((x) => ownerOf(x.entity)).filter(Boolean))].sort(), [all]);
  const apps = useMemo(() => [...new Set(all.map((x) => x.entity.app ?? "").filter(Boolean))].sort(), [all]);

  if (!report) {
    return (
      <div className="stack">
        <h1>Health</h1>
        <p className="muted">This bundle has no usage or health data. Build it without <code>--no-usage</code> to include it.</p>
      </div>
    );
  }

  const set = (patch: Partial<Filters>) => update(toParams(patch));
  const focus = (patch: Partial<Filters>, v: View = "objects") => {
    setFilters({ ...patch }, v);
    requestAnimationFrame(() => listTop.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const active = Object.entries(filters).some(([k, v]) => k !== "showHandled" && !!v);

  const save = async (x: Item, state: AckState, days: number | undefined, note: string) => {
    const until = days ? new Date(Date.now() + days * 86400000).toISOString() : undefined;
    const ack = await store.save({ entity: x.entity.id, check: x.check, state, until, status: x.status, note: note || undefined });
    setAcks((a) => [...a.filter((y) => y._key !== ack._key), ack]);
  };
  const remove = async (ack: Ack) => {
    await store.remove(ack._key);
    setAcks((a) => a.filter((y) => y._key !== ack._key));
  };

  const critical = open.filter((x) => x.status === "critical");
  const criticalIds = new Set(critical.map((x) => x.entity.id));
  const tiles: { num: number; label: string; onClick: () => void; title: string }[] = [
    { num: criticalIds.size, label: "objects critical", onClick: () => focus({ status: "critical" }), title: "Show critical findings" },
    { num: new Set(open.filter((x) => x.status === "warning" && !criticalIds.has(x.entity.id)).map((x) => x.entity.id)).size, label: "objects with warnings", onClick: () => focus({ status: "warning" }), title: "Show warnings" },
    ...(compare ? [
      { num: open.filter((x) => x.isNew).length, label: "new since the last build", onClick: () => focus({ onlyNew: true }), title: "Show findings that are new" },
      { num: resolved.length, label: "fixed since the last build", onClick: () => jump("resolved"), title: "Show what was fixed" },
    ] : []),
    { num: all.length - open.length, label: "acknowledged", onClick: () => focus({ showHandled: true }), title: "Show acknowledged findings too" },
    { num: atRisk, label: "at risk upstream", onClick: () => jump("at-risk"), title: "Objects that depend on something with a problem" },
    { num: unusedCustom, label: "unused objects (custom apps)", onClick: () => jump("cleanup"), title: "Cleanup report" },
  ];

  const sections = SECTIONS.map((s) => ({ ...s, rows: objectRows(list.filter((x) => x.section === s.id)) }))
    .filter((s) => s.rows.length || (!active && s.checks.length && all.some((x) => x.section === s.id)) || (!active && ["data", "searches", "forwarders"].includes(s.id)));
  const webUrl = (e: Entity) => webUrlOf(bundle, e);

  return (
    <div className="stack">
      <div>
        <h1>Health</h1>
        <p className="lede">Data freshness, volume, ingestion and scheduler problems, tokens, storage, and objects nobody uses.</p>
        <p className="muted small">{asOf(report.message)} Thresholds: {thresholdText(report.thresholds)}.</p>
      </div>

      <div className="tiles">
        {tiles.map((t) => (
          <button key={t.label} type="button" className="tile tile-btn" onClick={t.onClick} title={t.title}>
            <span className="tile-num">{t.num.toLocaleString()}</span><span className="tile-label">{t.label}</span>
          </button>
        ))}
      </div>

      {(bundle.healthHistory?.length ?? 0) > 1 ? (
        <HealthTrend history={bundle.healthHistory!} />
      ) : (
        <p className="muted small">The trend and what changed appear after the next build: each build is compared with the one before it.</p>
      )}

      {counts.length > 0 && (
        <section>
          <h2>Findings by check</h2>
          <CheckBars counts={counts} selected={filters.check} onSelect={(check) => set({ check })} />
        </section>
      )}

      <div ref={listTop} className="health-filters">
        <input type="search" placeholder="Filter findings" aria-label="Filter findings" value={filters.text ?? ""} onChange={(e) => set({ text: e.target.value })} />
        <select aria-label="Status" value={filters.status ?? ""} onChange={(e) => set({ status: e.target.value as Filters["status"] })}>
          <option value="">Any status</option><option value="critical">Critical</option><option value="warning">Warning</option>
        </select>
        <select aria-label="Area" value={filters.section ?? ""} onChange={(e) => set({ section: e.target.value })}>
          <option value="">Every area</option>
          {SECTIONS.filter((s) => all.some((x) => x.section === s.id)).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <select aria-label="Owner" value={filters.owner ?? ""} onChange={(e) => set({ owner: e.target.value })}>
          <option value="">Any owner</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select aria-label="App" value={filters.app ?? ""} onChange={(e) => set({ app: e.target.value })}>
          <option value="">Any app</option>
          {apps.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        {compare && <label className="sort"><input type="checkbox" checked={!!filters.onlyNew} onChange={(e) => set({ onlyNew: e.target.checked })} /> New only</label>}
        <label className="sort"><input type="checkbox" checked={!!filters.showHandled} onChange={(e) => set({ showHandled: e.target.checked })} /> Show acknowledged</label>
        {filters.check && <span className="chip">{checkTitle(filters.check)} <button type="button" className="link-btn" aria-label="Clear check filter" onClick={() => set({ check: undefined })}>×</button></span>}
        {active && <button type="button" className="link-btn small" onClick={() => setFilters({ showHandled: filters.showHandled })}>Clear filters</button>}
      </div>

      <div className="results-bar">
        <div className="seg" role="tablist" aria-label="Group findings">
          {([["objects", "By object"], ["owners", "By owner"], ["apps", "By app"]] as [View, string][]).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "active" : undefined} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
        <span className="muted small" role="status">{list.length.toLocaleString()} finding{list.length === 1 ? "" : "s"}{active ? " match" : ""}</span>
        <button type="button" className="btn btn-small" disabled={!list.length}
          onClick={() => downloadText("delvecat-health-findings.csv", toCsv([HEALTH_CSV, ...csvRows(list)]))}>Download CSV</button>
      </div>
      <p className="muted small">
        {canWrite
          ? <>Acknowledge a finding to accept it or snooze it; acknowledged findings are hidden until they get worse or the snooze ends. Kept {store.where}.</>
          : IN_SPLUNK ? <>Catalog publishers and admins can accept or snooze findings; everyone sees what they decided.</> : null}
      </p>

      {view === "objects" && sections.map((s) => (
        <section key={s.id} id={`health-${s.id}`}>
          <h2>{s.title} <span className="muted">({s.rows.length})</span></h2>
          <DataTable
            rows={s.rows}
            rowKey={(r) => r.entity.id}
            empty={<p className="muted">{active ? "Nothing matches the filters." : s.empty}</p>}
            columns={[
              { label: "Object", value: (r) => r.entity.displayName ?? r.entity.name, render: (r) => <ObjectCell e={r.entity} /> },
              { label: "Status", value: (r) => (r.status === "critical" ? 0 : 1), render: (r) => <StatusLabel status={r.status} /> },
              { label: "Findings", value: (r) => r.items.map((x) => x.message).join("; "), render: (r) => r.items.map((x) => (
                <div key={x.check} className={`finding${x.handled ? " finding-handled" : ""}`}>
                  <div>
                    <strong className="small">{checkTitle(x.check)}</strong>{x.isNew && <> <NewBadge /></>}
                    {x.since && !x.isNew && compare && <span className="muted small" title={new Date(x.since).toLocaleString()}> · first seen {ago(x.since)}</span>}
                  </div>
                  <div>{x.message}</div>
                  <RemedyBox item={x} webUrl={webUrl(x.entity)} inSplunk={IN_SPLUNK} prefix={prefix} />
                  <AckControl item={x} canWrite={canWrite} onSave={(st, d, n) => save(x, st, d, n)} onRemove={remove} />
                </div>
              )) },
              { label: "Owner", value: (r) => ownerOf(r.entity), render: (r) => ownerOf(r.entity) || <span className="muted">—</span> },
              ...(s.id === "data" || s.id === "searches"
                ? [{ label: s.id === "data" ? "Daily events" : "Per day", noSort: true, value: () => "", render: (r: { entity: Entity }) => <Trend e={r.entity} section={s.id} /> }]
                : []),
            ]}
          />
        </section>
      ))}

      {view !== "objects" && (
        <section>
          <h2>{view === "owners" ? "Who needs to act" : "Findings by app"}</h2>
          <p className="muted small">Click a row's name to see its findings. The CSV above has every finding with its {view === "owners" ? "owner" : "app"}, to send to each team.</p>
          <DataTable
            rows={groupRows(list, view === "owners" ? "owner" : "app")}
            rowKey={(r) => r.key || "(none)"}
            empty={<p className="muted">No findings.</p>}
            csvName={view === "owners" ? "delvecat-health-by-owner.csv" : "delvecat-health-by-app.csv"}
            columns={[
              { label: view === "owners" ? "Owner" : "App", value: (r) => r.key, render: (r) => (
                <button type="button" className="link-btn" onClick={() => focus({ ...filters, [view === "owners" ? "owner" : "app"]: r.key }, "objects")}>
                  {r.key || <span className="muted">(none)</span>}
                </button>
              ) },
              { label: "Critical", value: (r) => r.critical },
              { label: "Warnings", value: (r) => r.warning },
              ...(compare ? [{ label: "New", value: (r: { newFindings: number }) => r.newFindings }] : []),
              { label: "Objects", value: (r) => r.objects },
              { label: "Most common", value: (r) => r.top.join("; ") },
            ]}
          />
        </section>
      )}

      {compare && (
        <section id="resolved">
          <h2>Fixed since the last build <span className="muted">({resolved.length})</span></h2>
          <p className="muted small">Findings the previous build had that this one does not: fixed, or the object was disabled or removed.</p>
          <DataTable
            rows={resolved}
            rowKey={(r) => `${r.id}|${r.check}`}
            empty={<p className="muted">Nothing was fixed since the last build.</p>}
            columns={[
              { label: "Object", value: (r) => r.name, render: (r) => (
                <><span className="muted rel-type">{typeLabel(r.type as EntityType)}</span>{" "}
                  {catalog.byId.has(r.id) ? <Link to={entityPath(r.id)}>{r.name}</Link> : r.name}
                  {r.app && <div className="muted small">{r.app}</div>}</>
              ) },
              { label: "Was", value: (r) => (r.status === "critical" ? 0 : 1), render: (r) => <StatusLabel status={r.status} /> },
              { label: "Finding", value: (r) => `${checkTitle(r.check)}: ${r.message}`, render: (r) => <><strong className="small">{checkTitle(r.check)}</strong><div>{r.message}</div></> },
              { label: "How", value: (r) => r.how ?? "", render: (r) => (r.how === "fixed" ? "Fixed" : r.how === "removed" ? "Object removed" : r.how === "disabled" ? "Object disabled" : "—") },
              { label: "Open for", value: (r) => r.since ?? "", render: (r) => (r.since ? ago(r.since, new Date(bundle.generatedAt)).replace(" ago", "") : "—") },
            ]}
          />
        </section>
      )}

      <AtRisk />
      <Cleanup />
    </div>
  );
}

