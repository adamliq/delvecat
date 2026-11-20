import { Link } from "react-router-dom";
import type { EntityType } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { entityPath, searchPath } from "../lib/routes";
import { measuredAt } from "../lib/health";
import { relative } from "../lib/propertyFormat";

const OVERDUE_DAYS = 365;
import { coverage, formatValue, label, propertyDefs, propertyValues, valueStrings, type PropertyDef } from "../lib/structured";

function allowed(d: PropertyDef): { value: string; description?: string }[] {
  return ((d.allowedValues ?? []) as unknown[]).map((a) =>
    a && typeof a === "object" && "value" in a
      ? { value: String((a as { value: unknown }).value), description: (a as { description?: string }).description }
      : { value: String(a) });
}

export function PropertiesPage() {
  const { catalog } = useCatalog();
  const entities = catalog.bundle.entities;
  const defs = propertyDefs(catalog.bundle);
  const now = measuredAt(catalog.bundle);
  // Dates more than a year old (a review, an audit, a certification) are due again.
  const overdue = (d: PropertyDef) => entities.filter((e) => {
    const v = propertyValues(e)[d.id];
    return v !== undefined && valueStrings(v).some((x) => (now - Date.parse(x)) / 86400000 > OVERDUE_DAYS);
  }).length;
  return (
    <div className="stack">
      <div>
        <h1>Structured properties</h1>
        <p className="lede">Typed fields your team defines in annotation files, such as retention tier or compliance scope, and how much of the catalog has them filled in.</p>
      </div>
      {defs.length === 0 && (
        <p className="muted">No structured properties are defined. Add a <code>structuredProperties</code> list to an annotation file to define some.</p>
      )}
      {defs.map((d) => {
        const c = coverage(entities, d);
        const pct = c.applicable ? Math.round((100 * c.filled) / c.applicable) : 0;
        const counts = new Map<string, number>();
        for (const e of entities) {
          const v = propertyValues(e)[d.id];
          if (v !== undefined) for (const s of valueStrings(v)) counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const values = allowed(d);
        for (const k of counts.keys()) if (!values.some((a) => a.value === k)) values.push({ value: k });
        return (
          <section key={d.id} id={d.id}>
            <h2>{label(d)} <span className="muted small"><code>{d.id}</code></span></h2>
            {d.description && <p>{d.description}</p>}
            <dl className="facts">
              <dt>Type</dt>
              <dd>{d.type}{d.cardinality === "multiple" ? ", several values allowed" : ""}</dd>
              <dt>Applies to</dt>
              <dd>{d.appliesTo?.length ? d.appliesTo.map((t) => pluralTypeLabel(t as EntityType)).join(", ") : "all objects"}</dd>
              <dt>Filled in</dt>
              <dd>
                {c.filled.toLocaleString()} of {c.applicable.toLocaleString()} ({c.filled > 0 && pct === 0 ? "<1" : pct}%)
                {d.required && <span className="muted"> · required</span>}
              </dd>
              {d.type === "date" && overdue(d) > 0 && (
                <>
                  <dt>Overdue</dt>
                  <dd><span className="status-label status-warning">! {overdue(d)} object{overdue(d) === 1 ? "" : "s"} last set more than a year ago</span></dd>
                </>
              )}
              {c.missing > 0 && (
                <>
                  <dt>Missing</dt>
                  <dd>
                    <Link to={searchPath({ missing: d.id })}>
                      <span className="status-label status-warning">! {c.missing} object{c.missing === 1 ? "" : "s"} missing this required value</span>
                    </Link>
                  </dd>
                </>
              )}
            </dl>
            {values.length > 0 && (
              <div className="table-wrap">
                <table className="mini-table">
                  <thead><tr><th>Value</th><th>{d.type === "date" ? "Age" : "Meaning"}</th><th>Objects</th></tr></thead>
                  <tbody>
                    {(d.type === "date" ? [...values].sort((a, b) => a.value.localeCompare(b.value)) : values).map((a) => {
                      const n = counts.get(a.value) ?? 0;
                      const holders = n > 0 && !d.showInFilters ? entities.filter((e) => {
                        const v = propertyValues(e)[d.id];
                        return v !== undefined && valueStrings(v).includes(a.value);
                      }) : [];
                      const days = d.type === "date" ? (now - Date.parse(a.value)) / 86400000 : 0;
                      return (
                        <tr key={a.value}>
                          <td>{d.type === "date" ? formatValue(d, a.value) : <code>{a.value}</code>}</td>
                          <td>{d.type === "date" ? (
                            days > OVERDUE_DAYS
                              ? <span className="status-label status-warning" title="Older than a year: review it again">! {relative(a.value, now)}, overdue</span>
                              : <span className="muted">{relative(a.value, now)}</span>
                          ) : a.description ?? <span className="muted">—</span>}</td>
                          <td>
                            {n > 0 && d.showInFilters ? <Link to={searchPath({ [`p.${d.id}`]: a.value })}>{n}</Link>
                              : holders.length ? (
                                <details className="holders">
                                  <summary>{n}</summary>
                                  <ul className="plain-list small">{holders.map((e) => <li key={e.id}><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link></li>)}</ul>
                                </details>
                              ) : n}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
