import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { dailySeries } from "../lib/health";
import { alertSeries, problemSeries } from "../lib/healthView";
import { usagePercentile } from "../lib/insights";
import { pluralTypeLabel } from "../lib/labels";
import { Meter } from "./Meter";
import { StatusLabel } from "../pages/HealthPage";
import { Sparkline } from "./Sparkline";

const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString() : "—");
/** Splunk's relative time ("-30d") in words ("the last 30 days"). */
const fmtWindow = (w: string) => {
  const m = /^-(\d+)([dhm])$/.exec(w);
  if (!m) return w;
  const unit = { d: "day", h: "hour", m: "minute" }[m[2] as "d" | "h" | "m"];
  return `the last ${m[1]} ${unit}${m[1] === "1" ? "" : "s"}`;
};
const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

export function UsagePanel({ entity }: { entity: Entity }) {
  const { catalog } = useCatalog();
  const u = entity.usage;
  const h = entity.health;
  const percentile = usagePercentile(catalog, entity);
  const series = dailySeries(entity);
  const problems = problemSeries(entity);
  const fires = alertSeries(entity);
  const s = u?.scheduler as Record<string, number | string | null> | undefined;
  const facts: [string, string][] = [];
  if (u?.runs) facts.push(["Runs", `${u.runs.toLocaleString()} by ${u.users ?? "?"} user(s)`]);
  if (u?.views) facts.push(["Views", `${u.views.toLocaleString()} by ${u.viewers ?? "?"} user(s)`]);
  if (u?.panelSearchRuns) facts.push(["Panel searches", u.panelSearchRuns.toLocaleString()]);
  if (u?.searches) facts.push(["Searches run", u.searches.toLocaleString()]);
  if (u?.adhocSearches) facts.push(["Referenced by ad-hoc searches", u.adhocSearches.toLocaleString()]);
  // HTTP Event Collector tokens (inputs of kind "http"): what they received, and what was refused.
  const hec = u as Record<string, unknown> | undefined;
  if (typeof hec?.hecEvents === "number") {
    const bytes = Number(hec.hecBytes ?? 0);
    facts.push([
      "Events received",
      `${hec.hecEvents.toLocaleString()} (${fmtBytes(bytes)})${hec.hecWindow ? ` in ${fmtWindow(String(hec.hecWindow))}` : ""}`,
    ]);
  }
  const rejections = (hec?.hecRejections as { reason: string; index?: string; count: number }[] | undefined) ?? [];
  if (rejections.length) {
    facts.push([
      "Rejected requests",
      rejections.map((r) => `${r.count.toLocaleString()} × ${r.reason}${r.index ? ` (index ${r.index})` : ""}`).join("; "),
    ]);
  }
  // Alerts and detections: how often they triggered, not just ran.
  if (typeof hec?.alertFires === "number") {
    const fires = hec.alertFires;
    const window = hec.alertWindow ? ` in ${fmtWindow(String(hec.alertWindow))}` : "";
    const suppressed = Number(hec.alertsSuppressed ?? 0);
    facts.push([
      "Fired",
      (fires ? `${fires.toLocaleString()} time${fires === 1 ? "" : "s"}${window}` : `Never${window}`) +
        (suppressed ? ` (${suppressed.toLocaleString()} more suppressed by throttling)` : ""),
    ]);
    if (hec.lastFired) facts.push(["Last fired", fmtDate(String(hec.lastFired))]);
  }
  // Authentication tokens: lifetime and use, from their metadata.
  if (entity.type === "authToken") {
    const p = (entity.properties ?? {}) as Record<string, unknown>;
    facts.push(["Token for", String(p.user ?? "—")]);
    facts.push(["Issued", `${fmtDate(p.issuedAt as string | undefined)}${p.issuedBy ? ` by ${p.issuedBy}` : ""}`]);
    facts.push(["Expires", p.neverExpires ? "Never" : fmtDate(p.expiresAt as string | undefined)]);
    facts.push(["Last used", p.lastUsed ? fmtDate(String(p.lastUsed)) : "Never"]);
  }
  if (u?.lastUsed) facts.push([typeof hec?.hecEvents === "number" ? "Last event" : "Last used", fmtDate(u.lastUsed)]);
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
          {problems && (<><dt>Skipped or failed runs a day</dt><dd><Sparkline series={problems} width={220} unit="skipped or failed runs" label={`Skipped or failed runs per day for ${entity.name}`} /></dd></>)}
          {fires && (<><dt>Alerts fired a day</dt><dd><Sparkline series={fires} width={220} unit="alerts fired" label={`Alerts fired per day for ${entity.name}`} /></dd></>)}
          {facts.map(([k, v]) => <div key={k} className="fact-pair"><dt>{k}</dt><dd>{v}</dd></div>)}
          {popularity && <div className="fact-pair"><dt>Popularity</dt><dd>{popularity}</dd></div>}
        </dl>
      )}
    </section>
  );
}
