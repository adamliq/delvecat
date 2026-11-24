import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { measuredAt } from "../lib/health";
import { isIsoDate, numberWithUnit, parseDate, propLabel, REFERENCE_KEYS, relative, valueLabel } from "../lib/propertyFormat";

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** The object whose properties are shown, so names of other objects can link to them. */
export const PropContext = createContext<{ catalog: Catalog; entity: Entity } | null>(null);

function Reference({ type, name }: { type: string; name: string }) {
  const ctx = useContext(PropContext);
  if (!ctx || !type) return <>{name}</>;
  const target = ctx.catalog.findOne(ctx.entity.instance, type, name);
  return target ? <Link to={`/entity/${encodeURIComponent(target.id)}`}>{name}</Link> : <>{name}</>;
}

/** A property value, readable: units from its key, local dates, links to named objects. */
export function PropValue({ value, name }: { value: unknown; name?: string }): ReactNode {
  const ctx = useContext(PropContext);
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return (name && (numberWithUnit(name, value) ?? (valueLabel(name, String(value)) !== String(value) ? valueLabel(name, String(value)) : undefined))) || value.toLocaleString();
  if (typeof value === "string") {
    if (isIsoDate(value)) {
      const t = parseDate(value);
      return (
        <time dateTime={new Date(t).toISOString()} title={`${value}; the age is counted from when the catalog was measured`}>
          {new Date(t).toLocaleString()} <span className="muted">({relative(value, ctx ? measuredAt(ctx.catalog.bundle) : undefined)})</span>
        </time>
      );
    }
    if (name && REFERENCE_KEYS[name]) return <Reference type={REFERENCE_KEYS[name]} name={value} />;
    return valueLabel(name, value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">none</span>;
    if (value.every(isScalar)) {
      return (
        <span className="chips">
          {value.map((v, i) => (
            <span key={i} className="chip">{String(v)}</span>
          ))}
        </span>
      );
    }
    const records = value as Record<string, unknown>[];
    const cols = [...new Set(records.flatMap((r) => Object.keys(r ?? {})))];
    return (
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr>{cols.map((c) => <th key={c}>{propLabel(c)}</th>)}</tr></thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}><PropValue value={r?.[c]} name={c} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="muted">none</span>;
  return (
    <dl className="facts nested">
      {entries.map(([k, v]) => (
        <div key={k} className="fact-pair"><dt title={k}>{propLabel(k)}</dt><dd><PropValue value={v} name={k} /></dd></div>
      ))}
    </dl>
  );
}
