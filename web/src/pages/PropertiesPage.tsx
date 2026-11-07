import { Link } from "react-router-dom";
import type { EntityType } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { pluralTypeLabel } from "../lib/labels";
import { searchPath } from "../lib/routes";
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
                  <thead><tr><th>Value</th><th>Meaning</th><th>Objects</th></tr></thead>
                  <tbody>
                    {values.map((a) => {
                      const n = counts.get(a.value) ?? 0;
                      return (
                        <tr key={a.value}>
                          <td>{d.type === "date" ? formatValue(d, a.value) : <code>{a.value}</code>}</td>
                          <td>{a.description ?? <span className="muted">—</span>}</td>
                          <td>{n > 0 && d.showInFilters ? <Link to={searchPath({ [`p.${d.id}`]: a.value })}>{n}</Link> : n}</td>
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
