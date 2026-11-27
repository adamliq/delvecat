import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { CIM_FIELDS } from "./cimReference";
import { fieldName } from "./fieldLineage";
import { lookupFieldEntities, schemaLookups } from "./lookups";

/** Fields of a sourcetype (sampled or defined in props.conf), by name; for a lookup or KV
 * Store collection, its fields as field-like objects. */
export function schemaFields(catalog: Catalog, st: Entity): Entity[] {
  let perCatalog = fieldsCache.get(catalog);
  if (!perCatalog) fieldsCache.set(catalog, (perCatalog = new Map()));
  let fields = perCatalog.get(st);
  if (!fields) {
    const raw = st.type === "lookup" || st.type === "kvCollection"
      ? lookupFieldEntities(st)
      : catalog.edgesFrom(st.id)
        .filter((x) => x.type === "contains")
        .map((x) => catalog.byId.get(x.to))
        .filter((f): f is Entity => f?.type === "field");
    fields = byName(raw);
    perCatalog.set(st, fields);
  }
  return fields;
}

/** Fields worked out once per catalog: several Insights and Schemas panels ask for the
 * same sourcetypes (callers must not change the list). */
const fieldsCache = new WeakMap<Catalog, Map<Entity, Entity[]>>();
/** The same order as localeCompare, without creating a collator for every comparison. */
const collator = new Intl.Collator();

/** Sorted by field name (each name worked out once, not per comparison). */
function byName(fields: Entity[]): Entity[] {
  return fields
    .map((f) => [fieldName(f), f] as const)
    .sort((a, b) => collator.compare(a[0], b[0]))
    .map(([, f]) => f);
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
  let idx = modelIndex.get(catalog);
  if (!idx) modelIndex.set(catalog, (idx = buildModelIndex(catalog)));
  const out = new Map<string, Entity>();
  for (const dm of idx.direct.get(st.id) ?? []) out.set(dm.id, dm);
  for (const tag of idx.tags.get(st.id) ?? []) for (const dm of idx.tagUsers.get(tag) ?? []) out.set(dm.id, dm);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Who maps to what, from one pass over the relationships (each sourcetype's incoming
 * relationships include every host sending to it: millions on large estates). */
const modelIndex = new WeakMap<Catalog, { direct: Map<string, Entity[]>; tags: Map<string, string[]>; tagUsers: Map<string, Entity[]> }>();

function buildModelIndex(catalog: Catalog) {
  const direct = new Map<string, Entity[]>(); // sourcetype -> data models reading it
  const tags = new Map<string, string[]>(); // sourcetype -> tags mapped to it
  const tagUsers = new Map<string, Entity[]>(); // tag -> data models using it
  const add = <V,>(m: Map<string, V[]>, k: string, v: V) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const x of catalog.bundle.edges) {
    if (x.type !== "reads" && x.type !== "mapsTo" && x.type !== "uses") continue;
    const from = catalog.byId.get(x.from);
    if (!from) continue;
    if (x.type === "reads" && from.type === "dataModel") add(direct, x.to, from);
    else if (x.type === "mapsTo" && from.type === "tag") add(tags, x.to, from.id);
    else if (x.type === "uses" && from.type === "dataModel") add(tagUsers, x.to, from);
  }
  return { direct, tags, tagUsers };
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

/** Sourcetypes and lookups with the most similar field names, best first. */
export function similarSchemas(catalog: Catalog, st: Entity, limit = 6) {
  const mine = names(catalog, st);
  if (!mine.size) return [];
  return [...catalog.entities.filter((o) => o.type === "sourcetype"), ...schemaLookups(catalog)]
    .filter((o) => o.id !== st.id)
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

/** Field-by-field comparison of two sourcetypes or lookups. */
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

/** Everything with a schema: sourcetypes with fields, then lookups and KV Store collections. */
export const schemaObjects = (catalog: Catalog) => [...schemaSourcetypes(catalog), ...schemaLookups(catalog)];
