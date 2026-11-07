import { Link } from "react-router-dom";
import type { Catalog } from "../lib/catalog";
import { owners } from "../lib/annotate";
import { termsOfField } from "../lib/glossaryFields";
import { effectiveClassifications } from "../lib/governance";
import { healthStatus } from "../lib/health";
import { DOCUMENTED_TYPES, isVendor, kpis } from "../lib/insights";
import { searchPath } from "../lib/routes";
import { cimCoverage, schemaSourcetypes, schemaFields } from "../lib/schema";
import { label, propertyDefs, propertyValues, valueStrings } from "../lib/structured";

/** KPI tiles with a target marker; met / below is shown with an icon and words, not color alone. */
export function KpiTiles({ catalog, includeVendor }: { catalog: Catalog; includeVendor: boolean }) {
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
  return (
    <div className="kpis">
      {list.map((k) => {
        const met = k.value !== undefined && k.value >= k.target;
        return (
          <div key={k.key} className="kpi">
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
          </div>
        );
      })}
    </div>
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
