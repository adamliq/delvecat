import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { searchPath } from "../lib/routes";
import { allowedDescription, applies, formatValue, label, propertyDefs, propertyValues, valueStrings, type PropertyDef } from "../lib/structured";

function Value({ def, value }: { def: PropertyDef; value: string | number | boolean }) {
  const text = formatValue(def, value);
  if (def.type === "url" && typeof value === "string" && /^https?:\/\//.test(value)) {
    return <a href={value} target="_blank" rel="noreferrer noopener">{text}</a>;
  }
  const hint = allowedDescription(def, value);
  return <span title={hint}>{text}{hint && <span className="muted small"> — {hint}</span>}</span>;
}

export function PropertiesPanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const defs = propertyDefs(catalog.bundle).filter((d) => applies(d, entity));
  const values = propertyValues(entity);
  const missing = new Set(entity.annotations?.missingProperties ?? []);
  const shown = defs.filter((d) => values[d.id] !== undefined || missing.has(d.id));
  if (!shown.length) return null;
  return (
    <section>
      <h2>Structured properties <Link to="/properties" className="small">all properties</Link></h2>
      <dl className="facts">
        {shown.map((d) => {
          const v = values[d.id];
          return (
            <Fragment key={d.id}>
              <dt title={d.description}>{label(d)}</dt>
              <dd>
                {v === undefined ? (
                  <span className="status-label status-warning">! Required, not set</span>
                ) : (
                  (Array.isArray(v) ? v : [v]).map((x, i) => (
                    <span key={String(x)}>
                      {i > 0 && ", "}
                      {d.showInFilters ? (
                        <Link to={searchPath({ [`p.${d.id}`]: valueStrings(x)[0] })}><Value def={d} value={x} /></Link>
                      ) : (
                        <Value def={d} value={x} />
                      )}
                    </span>
                  ))
                )}
              </dd>
            </Fragment>
          );
        })}
      </dl>
    </section>
  );
}
