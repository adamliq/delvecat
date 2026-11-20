import { Link } from "react-router-dom";
import type { Catalog } from "../lib/catalog";
import type { Entity } from "../generated/catalog";
import { effectiveDescription, owners } from "../lib/annotate";
import { typeLabel } from "../lib/labels";
import { DataTable } from "./DataTable";
import { termsOfField } from "../lib/glossaryFields";
import { effectiveClassifications } from "../lib/governance";
import { healthStatus } from "../lib/health";
import { DOCUMENTED_TYPES, isVendor, kpis } from "../lib/insights";
import { entityPath, searchPath } from "../lib/routes";
import { cimCoverage, schemaSourcetypes, schemaFields } from "../lib/schema";
import { label, propertyDefs, propertyValues, valueStrings } from "../lib/structured";

type Point = NonNullable<Catalog["bundle"]["healthHistory"]>[number];

/** Percent per build for a target the build records (descriptions, ownership). */
function kpiTrend(history: Point[], key: string): number[] | undefined {
  const field = key === "owned" ? "owned" : key === "described" ? "described" : undefined;
  if (!field) return undefined;
  const pts = history.filter((h) => h.documented);
  if (pts.length < 2) return undefined;
  return pts.map((h) => Math.round((100 * (h[field] ?? 0)) / (h.documented ?? 1)));
}

function Trend({ values, label }: { values: number[]; label: string }) {
  const w = 120, h = 26, step = (w - 4) / (values.length - 1);
  const pts = values.map((v, i) => `${2 + i * step},${h - 2 - (v / 100) * (h - 4)}`).join(" ");
  const change = values[values.length - 1] - values[values.length - 2];
  return (
    <span className="kpi-trend">
      <svg width={w} height={h} role="img" aria-label={`${label} over ${values.length} builds: ${values.join("%, ")}%`}><polyline points={pts} /></svg>
      <span className="muted small">{change === 0 ? "no change" : `${change > 0 ? "+" : ""}${change} pts`} since the last build</span>
    </span>
  );
}

/** What is missing for a target, as a list to work through. */
const WORKLIST: Record<string, { lacks: (e: Entity) => boolean; title: string } | { link: string; title: string }> = {
  owned: { lacks: (e) => !owners(e).length, title: "Objects without an owning team" },
  described: { lacks: (e) => !effectiveDescription(e), title: "Objects without a description" },
  cim: { link: "/schemas", title: "Map sourcetypes on the Schemas page" },
  terms: { link: "/glossary", title: "Link fields to terms in the Glossary" },
  quality: { link: searchPath({ quality: "failing checks" }), title: "Objects with failing checks" },
};

/** KPI tiles with a target marker; met / below is shown with an icon and words, not color alone.
 * Each opens a worklist of what is missing; ones the build records show a trend. */
export function KpiTiles({ catalog, includeVendor, open, onOpen }: { catalog: Catalog; includeVendor: boolean; open?: string; onOpen: (key: string | undefined) => void }) {
  const sts = schemaSourcetypes(catalog);
  let cimOk = 0, cimOf = 0, termOk = 0, termOf = 0;
  for (const st of sts) {
    const fields = schemaFields(catalog, st);
    const cim = cimCoverage(catalog, st);
    if (cim.models.length) { cimOk += cim.cimFields.size; cimOf += fields.length; }
    termOf += fields.length;
    termOk += fields.filter((f) => termsOfField(catalog, f).length).length;
  }
  const list = kpis(catalog, includeVendor, { fieldsInCim: [cimOk, cimOf], fieldsWithTerm: [termOk, termOf] });
  const history = catalog.bundle.healthHistory ?? [];
  const work = open ? WORKLIST[open] : undefined;
  return (
    <>
      <div className="kpis">
        {list.map((k) => {
          const met = k.value !== undefined && k.value >= k.target;
          const trend = includeVendor ? undefined : kpiTrend(history, k.key);
          return (
            <button key={k.key} type="button" className={`kpi kpi-btn${open === k.key ? " active" : ""}`} aria-pressed={open === k.key}
              onClick={() => onOpen(open === k.key ? undefined : k.key)} title="Show what is missing">
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-value">{k.value === undefined ? "n/a" : `${k.value}%`}</span>
              {k.value !== undefined && (
                <span className="kpi-track" role="meter" aria-label={`${k.label}: ${k.value}%, target ${k.target}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={k.value}>
                  <span className="kpi-fill" style={{ width: `${k.value}%` }} />
                  <span className="kpi-target" style={{ left: `${k.target}%` }} title={`Target ${k.target}%`} />
                </span>
              )}
              <span className="kpi-sub">
                {k.value !== undefined && <span className={`status-label ${met ? "status-good" : "status-warning"}`}>{met ? "✓ Target met" : "! Below target"}</span>}{" "}
                {k.sub} ({k.ok.toLocaleString()} of {k.of.toLocaleString()}). Target {k.target}%.
              </span>
              {trend && <Trend values={trend} label={k.label} />}
            </button>
          );
        })}
      </div>
      {work && "lacks" in work && <Worklist catalog={catalog} includeVendor={includeVendor} title={work.title} lacks={work.lacks} />}
      {work && "link" in work && <p className="small"><Link to={work.link}>{work.title}</Link></p>}
    </>
  );
}

function Worklist({ catalog, includeVendor, title, lacks }: { catalog: Catalog; includeVendor: boolean; title: string; lacks: (e: Entity) => boolean }) {
  const rows = catalog.entities.filter((e) => DOCUMENTED_TYPES.has(e.type) && (includeVendor || !isVendor(catalog, e)) && lacks(e));
  const byApp = new Map<string, number>();
  for (const e of rows) byApp.set(e.app ?? "(no app)", (byApp.get(e.app ?? "(no app)") ?? 0) + 1);
  return (
    <section className="worklist">
      <h3>{title} <span className="muted">({rows.length.toLocaleString()})</span></h3>
      <p className="small muted">By app: {[...byApp].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(" · ")}. Add them in <code>annotations/</code>, or with the object's Annotations tab.</p>
      <DataTable
        rows={rows}
        rowKey={(e) => e.id}
        csvName="delvecat-worklist.csv"
        limit={200}
        columns={[
          { label: "Object", value: (e) => e.displayName ?? e.name, render: (e) => <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link></> },
          { label: "App", value: (e) => e.app ?? "" },
          { label: "Splunk owner", value: (e) => e.owner ?? "" },
          { label: "Domain", value: (e) => e.annotations?.domain ?? "" },
        ]}
      />
    </section>
  );
}

const CLASS_SLOTS = ["var(--viz-slot-1)", "var(--viz-slot-2)", "var(--viz-slot-3)"];

/** Sampled fields by sensitive classification: one whole split into parts (tall segmented bar). */
export function FieldClassification({ catalog }: { catalog: Catalog }) {
  const fields = schemaSourcetypes(catalog).flatMap((st) => schemaFields(catalog, st));
  const counts = new Map<string, number>();
  for (const f of fields) {
    const roots = [...new Set(effectiveClassifications(f).filter((c) => c.sensitive).map((c) => c.name.split(".")[0]))];
    const key = roots[0] ?? "Unclassified";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unclassified = counts.get("Unclassified") ?? 0;
  counts.delete("Unclassified");
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, 3);
  const other = ranked.slice(3).reduce((n, [, c]) => n + c, 0);
  const parts: { name: string; n: number; color: string; dark?: boolean }[] = [
    ...named.map(([name, n], i) => ({ name, n, color: CLASS_SLOTS[i] })),
    ...(other ? [{ name: "Other classifications", n: other, color: "var(--viz-neutral)" }] : []),
    { name: "Unclassified", n: unclassified, color: "var(--viz-track)", dark: true },
  ].filter((p) => p.n > 0);
  const total = fields.length;
  if (!total) return <p className="muted">No sampled fields.</p>;
  return (
    <figure className="segbar-figure">
      <div className="segbar" role="img" aria-label={parts.map((p) => `${p.name}: ${p.n} of ${total} fields`).join(", ")}>
        {parts.map((p) => (
          <span key={p.name} className={`seg${p.dark ? " seg-light" : ""}`} style={{ flexGrow: p.n, background: p.color }} title={`${p.name}: ${p.n} fields (${Math.round((100 * p.n) / total)}%)`}>
            {p.n / total >= 0.08 && <span className="seg-label">{Math.round((100 * p.n) / total)}%</span>}
          </span>
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => <li key={p.name}><span className="net-key" style={{ background: p.color, borderRadius: 4 }} />{p.name} <strong>{p.n}</strong></li>)}
      </ul>
    </figure>
  );
}

/** Count of objects per value of each single-value structured property with fixed values (e.g. tier). */
export function PropertyDistributions({ catalog }: { catalog: Catalog }) {
  const defs = propertyDefs(catalog.bundle).filter((d) => d.allowedValues?.length && d.cardinality !== "multiple");
  if (!defs.length) return null;
  return (
    <>
      {defs.map((d) => {
        const values = (d.allowedValues as unknown[]).map((a) => String(a && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
        const counts = values.map((v) => ({ v, n: catalog.entities.filter((e) => valueStrings(propertyValues(e)[d.id] ?? []).includes(v)).length }));
        const max = Math.max(1, ...counts.map((c) => c.n));
        return (
          <figure key={d.id} className="rank-chart">
            <figcaption><strong>{label(d)}</strong> <span className="muted small">objects per value</span></figcaption>
            <ol className="rank-list">
              {counts.map(({ v, n }) => (
                <li key={v} className="rank-row" title={`${label(d)} ${v}: ${n}`}>
                  {n ? <Link className="rank-name" to={searchPath({ [`p.${d.id}`]: v })}>{v}</Link> : <span className="rank-name muted">{v}</span>}
                  <span className="rank-bar-track">
                    <span className="rank-bar" style={{ width: `calc((100% - 4em) * ${n / max})` }} />
                    <span className="rank-value">{n}</span>
                  </span>
                </li>
              ))}
            </ol>
          </figure>
        );
      })}
    </>
  );
}

/** Objects per owning team, with the share that is healthy. */
export function OwnersChart({ catalog, includeVendor }: { catalog: Catalog; includeVendor: boolean }) {
  const byOwner = new Map<string, { n: number; healthy: number }>();
  for (const e of catalog.entities) {
    if (!DOCUMENTED_TYPES.has(e.type) || (!includeVendor && isVendor(catalog, e))) continue;
    for (const o of owners(e)) {
      const c = byOwner.get(o) ?? { n: 0, healthy: 0 };
      c.n++;
      if (healthStatus(e) === "ok") c.healthy++;
      byOwner.set(o, c);
    }
  }
  const rows = [...byOwner.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  if (!rows.length) return null;
  const max = rows[0][1].n;
  return (
    <figure className="rank-chart">
      <figcaption><strong>Assets by owner</strong> <span className="muted small">objects, with the share that is healthy</span></figcaption>
      <ol className="rank-list">
        {rows.map(([o, c]) => (
          <li key={o} className="rank-row" title={`${o}: ${c.n} objects, ${Math.round((100 * c.healthy) / c.n)}% healthy`}>
            <Link className="rank-name" to={searchPath({ owner: o })}>{o}</Link>
            <span className="rank-bar-track">
              <span className="rank-bar" style={{ width: `calc((100% - 7.5em) * ${c.n / max})` }} />
              <span className="rank-value">{c.n} · {Math.round((100 * c.healthy) / c.n)}% ok</span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
