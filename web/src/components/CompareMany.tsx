import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { fieldName } from "../lib/fieldLineage";
import { entityPath } from "../lib/routes";
import { dataModelFields, fieldType, schemaFields } from "../lib/schema";
import { DataTable } from "./DataTable";

export const MAX_SCHEMAS = 6;

interface Column {
  entity: Entity;
  /** Field name -> type ("config" for configured fields, "field" for data model fields). */
  fields: Map<string, string>;
  isModel: boolean;
}

function columnOf(catalog: Catalog, e: Entity): Column {
  if (e.type === "dataModel") {
    return { entity: e, isModel: true, fields: new Map([...dataModelFields(e).names].map((n) => [n, "field"])) };
  }
  const fields = new Map<string, string>();
  for (const f of schemaFields(catalog, e)) {
    const t = fieldType(f);
    fields.set(fieldName(f), t === "unknown" ? "config" : t);
  }
  return { entity: e, isModel: false, fields };
}

/** Several sourcetypes (and data models) side by side: which fields each has, which are
 * common to all, and where the same name holds different types. */
export function CompareMany({ catalog, ids, onRemove }: { catalog: Catalog; ids: string[]; onRemove: (id: string) => void }) {
  const cols = ids.map((id) => catalog.byId.get(id)).filter((e): e is Entity => !!e).map((e) => columnOf(catalog, e));
  if (cols.length < 2) return <p className="muted">Add at least two sourcetypes or data models to compare.</p>;
  const names = [...new Set(cols.flatMap((c) => [...c.fields.keys()]))].sort((a, b) => a.localeCompare(b));
  const models = cols.filter((c) => c.isModel);
  const sts = cols.filter((c) => !c.isModel);
  const rows = names.map((name) => {
    const types = cols.map((c) => c.fields.get(name));
    const typed = new Set(sts.map((c) => c.fields.get(name)).filter((t): t is string => !!t && t !== "config"));
    return { name, types, present: types.filter(Boolean).length, differs: typed.size > 1, inModel: models.some((m) => m.fields.has(name)) };
  });
  const common = rows.filter((r) => r.present === cols.length).length;
  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile static"><span className="tile-num">{names.length}</span><span className="tile-label">field names in all</span></div>
        <div className="tile static"><span className="tile-num">{common}</span><span className="tile-label">in every one</span></div>
        <div className="tile static"><span className="tile-num">{rows.filter((r) => r.differs).length}</span><span className="tile-label">typed differently</span></div>
        {models.map((m) => {
          const need = [...m.fields.keys()];
          return sts.map((s) => {
            const have = need.filter((n) => s.fields.has(n)).length;
            return (
              <div key={`${m.entity.id}|${s.entity.id}`} className="tile static">
                <span className="tile-num">{need.length ? Math.round((100 * have) / need.length) : 0}%</span>
                <span className="tile-label">of {m.entity.name} fields in {s.entity.name} ({have} of {need.length})</span>
              </div>
            );
          });
        })}
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.name}
        csvName="delvecat-compare.csv"
        limit={500}
        columns={[
          { label: "Field", value: (r) => r.name, render: (r) => <><code>{r.name}</code>{r.differs && <> <span className="status-label status-warning" title="Typed differently across sourcetypes">! type</span></>}</> },
          { label: "In", value: (r) => r.present, render: (r) => `${r.present} of ${cols.length}` },
          ...cols.map((c, i) => ({
            label: `${c.isModel ? "◆ " : ""}${c.entity.displayName ?? c.entity.name}`,
            value: (r: (typeof rows)[number]) => r.types[i] ?? "",
            render: (r: (typeof rows)[number]) => (r.types[i]
              ? <span className={c.isModel ? "cmp-model" : undefined}>{c.isModel ? "✓" : r.types[i]}</span>
              : <span className={r.inModel && !c.isModel ? "status-label status-warning" : "muted"} title={r.inModel && !c.isModel ? "The data model expects this field" : undefined}>{r.inModel && !c.isModel ? "! missing" : "—"}</span>),
          })),
        ]}
      />
      <p className="small">
        Comparing:{" "}
        {cols.map((c, i) => (
          <span key={c.entity.id}>{i > 0 && " · "}<Link to={entityPath(c.entity.id)}>{c.entity.name}</Link>{" "}
            <button type="button" className="link-btn small" aria-label={`Remove ${c.entity.name}`} onClick={() => onRemove(c.entity.id)}>×</button></span>
        ))}
      </p>
    </div>
  );
}
