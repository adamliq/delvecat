import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { effectiveDescription } from "../lib/annotate";
import { entityPath } from "../lib/routes";
import { AnnotationChips } from "./EntityBits";
import { PropValue } from "./PropValue";

interface Table {
  caption: string;
  columns: string[];
  rows: { key: string; cells: ReactNode[] }[];
}

type Obj = Record<string, unknown>;
const props = (e: Entity) => (e.properties ?? {}) as Obj;
const observed = (e: Entity) => (props(e).observed ?? {}) as Obj;
const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : "—");
const link = (e: Entity, label?: string) => <Link to={entityPath(e.id)}>{label ?? e.displayName ?? e.name}</Link>;

/** The "schema" of an entity, when its type has one. */
export function fieldsTable(catalog: Catalog, e: Entity): Table | null {
  const p = props(e);
  switch (e.type) {
    case "sourcetype": {
      const fields = catalog
        .edgesFrom(e.id)
        .filter((x) => x.type === "contains")
        .map((x) => catalog.byId.get(x.to))
        .filter((f): f is Entity => f?.type === "field")
        .sort((a, b) => Number(observed(b).coverage ?? 0) - Number(observed(a).coverage ?? 0));
      if (!fields.length) return null;
      return {
        caption: "Fields seen in sampled events (search-time extractions, aliases, lookups included)",
        columns: ["Field", "Coverage", "Distinct values", "Numeric", "Annotations"],
        rows: fields.map((f) => ({
          key: f.id,
          cells: [
            <>{link(f)}{effectiveDescription(f) && <div className="muted small">{effectiveDescription(f)}</div>}</>,
            pct(observed(f).coverage),
            num(observed(f).distinctCount),
            props(f).numeric ? "Yes" : "No",
            <AnnotationChips entity={f} compact />,
          ],
        })),
      };
    }
    case "index": {
      const sts = catalog
        .edgesTo(e.id)
        .filter((x) => x.type === "feeds")
        .map((x) => catalog.byId.get(x.from))
        .filter((s): s is Entity => s?.type === "sourcetype");
      if (!sts.length) return null;
      const count = (s: Entity) => Number(((observed(s).eventsByIndex ?? {}) as Obj)[e.name] ?? 0);
      return {
        caption: `Sourcetypes observed in this index (${String(sts[0] && observed(sts[0]).window || "")})`,
        columns: ["Sourcetype", "Events", "Last seen", "Annotations"],
        rows: sts.sort((a, b) => count(b) - count(a)).map((s) => ({
          key: s.id,
          cells: [link(s), count(s).toLocaleString(), String(observed(s).lastSeen ?? "—"), <AnnotationChips entity={s} compact />],
        })),
      };
    }
    case "dataModel": {
      const datasets = (p.datasets ?? []) as Obj[];
      if (!datasets.length) return null;
      return {
        caption: "Datasets",
        columns: ["Dataset", "Parent", "Fields", "Constraint"],
        rows: datasets.map((d, i) => ({
          key: String(d.name ?? i),
          cells: [String(d.displayName ?? d.name ?? ""), String(d.parent ?? "—"), <PropValue value={d.fields} />,
            d.constraint ? <code>{String(d.constraint)}</code> : "—"],
        })),
      };
    }
    case "kvCollection": {
      const fields = Object.entries((p.fields ?? {}) as Obj);
      if (!fields.length) return null;
      const accelerated = JSON.stringify(p.acceleratedFields ?? {});
      return {
        caption: "Collection fields",
        columns: ["Field", "Type", "Accelerated"],
        rows: fields.map(([name, type]) => ({
          key: name,
          cells: [name, String(type), accelerated.includes(`"${name}"`) ? "Yes" : "No"],
        })),
      };
    }
    case "lookup": {
      const fields = (p.fields ?? []) as string[];
      if (!fields.length) return null;
      return { caption: "Lookup fields", columns: ["Field"], rows: fields.map((f) => ({ key: f, cells: [f] })) };
    }
    default:
      return null;
  }
}

export function FieldsTab({ table }: { table: Table }) {
  return (
    <section>
      <p className="muted small">{table.caption}</p>
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.key}>{r.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
