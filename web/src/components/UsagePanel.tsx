import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { dailySeries } from "../lib/health";
import { usagePercentile } from "../lib/insights";
import { pluralTypeLabel } from "../lib/labels";
import { Meter } from "./Meter";
import { StatusLabel } from "../pages/HealthPage";
import { Sparkline } from "./Sparkline";

const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString() : "—");

export function UsagePanel({ entity }: { entity: Entity }) {
  const { catalog } = useCatalog();
  const u = entity.usage;
  const h = entity.health;
  const percentile = usagePercentile(catalog, entity);
  const series = dailySeries(entity);
  const s = u?.scheduler as Record<string, number | string | null> | undefined;
  const facts: [string, string][] = [];
  if (u?.runs) facts.push(["Runs", `${u.runs.toLocaleString()} by ${u.users ?? "?"} user(s)`]);
  if (u?.views) facts.push(["Views", `${u.views.toLocaleString()} by ${u.viewers ?? "?"} user(s)`]);
  if (u?.panelSearchRuns) facts.push(["Panel searches", u.panelSearchRuns.toLocaleString()]);
  if (u?.searches) facts.push(["Searches run", u.searches.toLocaleString()]);
  if (u?.adhocSearches) facts.push(["Referenced by ad-hoc searches", u.adhocSearches.toLocaleString()]);
  if (u?.lastUsed) facts.push(["Last used", fmtDate(u.lastUsed)]);
  const popularity = percentile !== undefined && (
    <Meter value={percentile} max={100} name="Usage percentile"
      label={<>used more than {percentile}% of {pluralTypeLabel(entity.type).toLowerCase()} <a href="#/insights" className="small">insights</a></>} />
  );
  if (s?.total) {
    facts.push(["Scheduler", `${s.success ?? 0} succeeded, ${s.skipped ?? 0} skipped, ${s.failed ?? 0} failed of ${s.total} (${s.window})`]);
    if (s.avgRuntimeSecs != null) facts.push(["Run time", `avg ${Number(s.avgRuntimeSecs).toFixed(1)}s, max ${Number(s.maxRuntimeSecs ?? 0).toFixed(1)}s`]);
  }
  if (!h && !facts.length && !series && !u?.unused) return null;
  return (
    <section>
      <h2>Usage and health</h2>
      {h ? (
        <ul className="plain-list">
          {h.checks.map((c) => <li key={c.check}><StatusLabel status={c.status} /> {c.message}</li>)}
        </ul>
      ) : <p><StatusLabel status="ok" /> <span className="muted small">No problems found.</span></p>}
      {u?.unused && <p><span className="status-label status-warning">! Unused</span> {u.reason}{u.builtin && <span className="muted small"> (Splunk built-in)</span>}</p>}
      {(facts.length > 0 || series) && (
        <dl className="facts">
          {series && (<><dt>Daily events</dt><dd><Sparkline series={series} width={220} label={`Daily events for ${entity.name}`} /></dd></>)}
          {facts.map(([k, v]) => <div key={k} className="fact-pair"><dt>{k}</dt><dd>{v}</dd></div>)}
          {popularity && <div className="fact-pair"><dt>Popularity</dt><dd>{popularity}</dd></div>}
        </dl>
      )}
    </section>
  );
}
