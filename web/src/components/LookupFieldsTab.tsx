import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { fieldName } from "../lib/fieldLineage";
import { dataModelsWithField } from "../lib/dataModels";
import { columnsSource, columnType, lookupColumns, lookupsWithField } from "../lib/lookups";
import { entityPath } from "../lib/routes";
import { DataTable } from "./DataTable";
import { SimilarSchemas } from "./SimilarSchemas";

const fieldIndex = new WeakMap<Catalog, Map<string, Entity[]>>();

/** Sourcetype fields by lower-case name. */
export function sourcetypeFieldsNamed(catalog: Catalog, name: string, instance?: string): Entity[] {
  let index = fieldIndex.get(catalog);
  if (!index) {
    index = new Map();
    for (const f of catalog.entities) {
      if (f.type !== "field") continue;
      const k = fieldName(f).toLowerCase();
      index.set(k, [...(index.get(k) ?? []), f]);
    }
    fieldIndex.set(catalog, index);
  }
  return (index.get(name.toLowerCase()) ?? []).filter((f) => !instance || f.instance === instance);
}

const sourcetypeOf = (f: Entity) => String((f.properties as { sourcetype?: unknown } | undefined)?.sourcetype ?? f.name.split("/")[0]);

function Source({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const from = columnsSource(entity);
  if (from === "header") return <p className="muted small">Fields read from the header row of the file.</p>;
  const other = from ? catalog.byId.get(from) : undefined;
  if (other) return <p className="muted small">Fields from <Link to={`${entityPath(other.id)}?tab=fields`}>{other.displayName ?? other.name}</Link>.</p>;
  return entity.type === "lookup" ? <p className="muted small">Fields as the lookup definition lists them.</p> : null;
}

/** The automatic lookups using this lookup, the sourcetypes they apply to and the fields
 * they add there. */
function Automatic({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const autos = catalog.edgesTo(entity.id)
    .filter((x) => x.type === "uses")
    .map((x) => catalog.byId.get(x.from))
    .filter((e): e is Entity => e?.type === "automaticLookup");
  if (!autos.length) return null;
  return (
    <section>
      <h2>Added to events automatically</h2>
      <p className="muted small">Automatic lookups using this lookup, and the fields they add to each sourcetype at search time.</p>
      <ul className="plain-list">
        {autos.map((a) => {
          const st = catalog.edgesFrom(a.id).map((x) => catalog.byId.get(x.to)).find((e) => e?.type === "sourcetype")
            ?? catalog.edgesTo(a.id).map((x) => catalog.byId.get(x.from)).find((e) => e?.type === "sourcetype");
          const added = catalog.edgesFrom(a.id).filter((x) => x.type === "definesField").map((x) => catalog.byId.get(x.to)).filter((f): f is Entity => !!f);
          const p = (a.properties ?? {}) as { stanza?: string; inputFields?: Record<string, string> };
          const matched = Object.entries(p.inputFields ?? {}).map(([k, v]) => (v && v !== k ? `${k} = ${v}` : k));
          return (
            <li key={a.id}>
              <Link to={entityPath(a.id)}>{a.displayName ?? a.name}</Link> on{" "}
              {st ? <Link to={`${entityPath(st.id)}?tab=fields`}>{st.displayName ?? st.name}</Link> : <code>{p.stanza}</code>}
              {matched.length > 0 && <> · matches on {matched.map((m, i) => <span key={m}>{i > 0 && ", "}<code>{m}</code></span>)}</>}
              {added.length > 0 && <> · adds {added.map((f, i) => <span key={f.id}>{i > 0 && ", "}<Link to={entityPath(f.id)}><code>{fieldName(f)}</code></Link></span>)}</>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Fields of a lookup or KV Store collection, with the sourcetypes and other lookups that
 * have a field of the same name, what automatic lookups add, and similar schemas. */
export function LookupFieldsTab({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const rows = useMemo(() => lookupColumns(entity).map((name) => ({
    name,
    type: columnType(entity, name),
    sourcetypes: sourcetypeFieldsNamed(catalog, name, entity.instance),
    lookups: lookupsWithField(catalog, name, entity.instance).filter((l) => l.id !== entity.id && l.id !== columnsSource(entity)),
    models: dataModelsWithField(catalog, name, entity.instance),
  })), [catalog, entity]);
  const typed = rows.some((r) => r.type);
  return (
    <div className="stack">
      <section>
        <Source catalog={catalog} entity={entity} />
        <DataTable
          rows={rows}
          rowKey={(r) => r.name}
          csvName={`${entity.name}-fields.csv`}
          columns={[
            { label: "Field", value: (r) => r.name, render: (r) => <code>{r.name}</code> },
            ...(typed ? [{ label: "Type", value: (r: (typeof rows)[number]) => r.type ?? "" }] : []),
            { label: "Sourcetypes with this field", value: (r) => r.sourcetypes.length, render: (r) => (r.sourcetypes.length
              ? <>{r.sourcetypes.slice(0, 4).map((f, i) => <span key={f.id}>{i > 0 && ", "}<Link to={entityPath(f.id)}>{sourcetypeOf(f)}</Link></span>)}{r.sourcetypes.length > 4 && <span className="muted"> +{r.sourcetypes.length - 4}</span>}</>
              : <span className="muted">—</span>) },
            { label: "Other lookups with it", value: (r) => r.lookups.length, render: (r) => (r.lookups.length
              ? <>{r.lookups.slice(0, 4).map((l, i) => <span key={l.id}>{i > 0 && ", "}<Link to={`${entityPath(l.id)}?tab=fields`}>{l.displayName ?? l.name}</Link></span>)}{r.lookups.length > 4 && <span className="muted"> +{r.lookups.length - 4}</span>}</>
              : <span className="muted">—</span>) },
            { label: "Data models with it", value: (r) => r.models.length, render: (r) => (r.models.length
              ? r.models.map((m, i) => <span key={m.model.id}>{i > 0 && ", "}<Link to={`${entityPath(m.model.id)}?tab=fields`}>{m.model.displayName ?? m.model.name}</Link></span>)
              : <span className="muted">—</span>) },
          ]}
        />
      </section>
      <Automatic catalog={catalog} entity={entity} />
      <SimilarSchemas catalog={catalog} entity={entity} />
    </div>
  );
}
