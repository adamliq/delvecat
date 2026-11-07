import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { CIM_FIELDS } from "./cimReference";
import { fieldName } from "./fieldLineage";

/** Fields of a sourcetype (sampled or defined in props.conf), by name. */
export function schemaFields(catalog: Catalog, st: Entity): Entity[] {
  return catalog.edgesFrom(st.id)
    .filter((x) => x.type === "contains")
    .map((x) => catalog.byId.get(x.to))
    .filter((f): f is Entity => f?.type === "field")
    .sort((a, b) => fieldName(a).localeCompare(fieldName(b)));
}

export type FieldType = "number" | "string" | "unknown";

/** Type of a field from sampling: number when every sampled value was numeric. */
export function fieldType(f: Entity): FieldType {
  const n = (f.properties as { numeric?: unknown } | undefined)?.numeric;
  return n === true ? "number" : n === false ? "string" : "unknown";
}

/** Share of sampled events without the field (1 - fill rate); undefined when not sampled. */
export function nullRate(f: Entity): number | undefined {
  const cov = ((f.properties as { observed?: { coverage?: unknown } } | undefined)?.observed ?? {}).coverage;
  return typeof cov === "number" ? 1 - cov : undefined;
}

const META = new Set(["_time", "host", "source", "sourcetype"]);

/** Field names of a data model: its own dataset fields, or the CIM reference when it has none. */
export function dataModelFields(dm: Entity): { names: Set<string>; fromReference: boolean } {
  const datasets = ((dm.properties ?? {}) as { datasets?: { name?: string; fields?: string[] }[] }).datasets ?? [];
  const own = new Set<string>();
  for (const d of datasets) {
    for (const raw of d.fields ?? []) {
      const n = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
      if (!META.has(n) && !datasets.some((x) => x.name === n)) own.add(n);
    }
  }
  if (own.size >= 3) return { names: own, fromReference: false };
  const ref = CIM_FIELDS[dm.name];
  return ref ? { names: new Set(ref), fromReference: true } : { names: own, fromReference: false };
}

/** Data models a sourcetype feeds: directly, or through a tag on it (CIM tagging). */
export function dataModelsOf(catalog: Catalog, st: Entity): Entity[] {
  const out = new Map<string, Entity>();
  for (const x of catalog.edgesTo(st.id)) {
    const from = catalog.byId.get(x.from);
    if (!from) continue;
    if (from.type === "dataModel" && x.type === "reads") out.set(from.id, from);
    if (from.type === "tag" && x.type === "mapsTo") {
      for (const y of catalog.edgesTo(from.id)) {
        const dm = catalog.byId.get(y.from);
        if (dm?.type === "dataModel" && y.type === "uses") out.set(dm.id, dm);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CimCoverage {
  models: Entity[];
  cimFields: Set<string>; // field names of the sourcetype that are data model fields
  pct: number | undefined; // undefined when the sourcetype maps to no data model
  fromReference: boolean;
}

export function cimCoverage(catalog: Catalog, st: Entity): CimCoverage {
  const models = dataModelsOf(catalog, st);
  const fields = schemaFields(catalog, st).map(fieldName);
  if (!models.length) return { models, cimFields: new Set(), pct: undefined, fromReference: false };
  const names = new Set<string>();
  let fromReference = false;
  for (const m of models) {
    const d = dataModelFields(m);
    d.names.forEach((n) => names.add(n));
    fromReference ||= d.fromReference;
  }
  const cimFields = new Set(fields.filter((n) => names.has(n)));
  return { models, cimFields, pct: fields.length ? Math.round((100 * cimFields.size) / fields.length) : undefined, fromReference };
}

const names = (catalog: Catalog, st: Entity) => new Set(schemaFields(catalog, st).map(fieldName));

/** Share of field names two schemas have in common (Jaccard). */
export function similarity(a: Set<string>, b: Set<string>): { shared: string[]; score: number } {
  const shared = [...a].filter((n) => b.has(n)).sort();
  const union = a.size + b.size - shared.length;
  return { shared, score: union ? shared.length / union : 0 };
}

/** Sourcetypes with the most similar field names, best first. */
export function similarSchemas(catalog: Catalog, st: Entity, limit = 6) {
  const mine = names(catalog, st);
  if (!mine.size) return [];
  return catalog.entities
    .filter((o) => o.type === "sourcetype" && o.id !== st.id)
    .map((o) => ({ entity: o, ...similarity(mine, names(catalog, o)) }))
    .filter((r) => r.shared.length)
    .sort((a, b) => b.score - a.score || b.shared.length - a.shared.length)
    .slice(0, limit);
}

export type CompareStatus = "same" | "differs" | "onlyA" | "onlyB";

export interface CompareRow {
  name: string;
  a?: Entity;
  b?: Entity;
  status: CompareStatus;
}

/** Field-by-field comparison of two sourcetypes. */
export function compareSchemas(catalog: Catalog, a: Entity, b: Entity): CompareRow[] {
  const fa = new Map(schemaFields(catalog, a).map((f) => [fieldName(f), f]));
  const fb = new Map(schemaFields(catalog, b).map((f) => [fieldName(f), f]));
  return [...new Set([...fa.keys(), ...fb.keys()])].sort().map((name) => {
    const x = fa.get(name), y = fb.get(name);
    const status: CompareStatus = x && y
      ? (fieldType(x) === fieldType(y) || fieldType(x) === "unknown" || fieldType(y) === "unknown" ? "same" : "differs")
      : x ? "onlyA" : "onlyB";
    return { name, a: x, b: y, status };
  });
}

/** Sourcetypes that have at least one field. */
export const schemaSourcetypes = (catalog: Catalog) =>
  catalog.entities.filter((e) => e.type === "sourcetype" && schemaFields(catalog, e).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
