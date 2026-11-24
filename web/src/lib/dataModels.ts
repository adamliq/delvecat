import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

export interface FieldInfo {
  name: string;
  type?: string;
  required?: boolean;
  multivalue?: boolean;
  hidden?: boolean;
  displayName?: string;
  comment?: string;
  /** eval, lookup, rex or geoip when a calculation produces the field. */
  calculation?: string;
}

export interface Calculation {
  type?: string;
  expression?: string;
  inputField?: string;
  lookup?: string;
  lookupInputs?: Record<string, string>;
  lookupOutputs?: Record<string, string>;
  outputs?: string[];
}

export interface Dataset {
  name: string;
  displayName?: string;
  parent?: string;
  /** Root.Child path when the dataset is below another one. */
  path?: string;
  comment?: string;
  fields?: string[];
  fieldInfo?: FieldInfo[];
  calculations?: Calculation[];
  constraint?: string;
}

/** A field of a dataset with where it is defined: this dataset or one it inherits from. */
export interface DatasetField extends FieldInfo {
  /** The dataset that defines it (this one, an ancestor, or BaseEvent for _time, host...). */
  from: string;
  inherited: boolean;
}

export const datasetsOf = (e: Entity): Dataset[] =>
  e.type === "dataModel" ? (((e.properties ?? {}) as { datasets?: Dataset[] }).datasets ?? []) : [];

export const datasetPath = (d: Dataset): string => d.path ?? d.name;

/** Fields of a dataset, each with its type and flags from the dataset that defines it. */
export function datasetFields(model: Entity, d: Dataset): DatasetField[] {
  const byName = new Map(datasetsOf(model).map((x) => [x.name, x]));
  const info = (name: string): { f?: FieldInfo; from: string } => {
    for (let cur: Dataset | undefined = d, hops = 0; cur && hops < 20; cur = byName.get(cur.parent ?? ""), hops++) {
      const f = cur.fieldInfo?.find((x) => x.name === name);
      if (f) return { f, from: cur.name };
    }
    return { from: name.startsWith("_") || ["host", "source", "sourcetype"].includes(name) ? "BaseEvent" : d.parent ?? d.name };
  };
  return (d.fields ?? []).map((name) => {
    const { f, from } = info(name);
    return { ...(f ?? { name }), name, from, inherited: from !== d.name };
  });
}

const META = new Set(["_time", "host", "source", "sourcetype"]);

/** Every field name of a data model (all datasets, calculated ones included), less the
 * event basics every model has. */
export function dataModelColumns(e: Entity): string[] {
  const out = new Set<string>();
  for (const d of datasetsOf(e)) for (const f of d.fields ?? []) if (!META.has(f) && !datasetsOf(e).some((x) => x.name === f)) out.add(f);
  return [...out];
}

const searchIndex = new WeakMap<Catalog, Map<string, Entity[]>>();

/** Searches that name this dataset (tstats from datamodel=, nodename=, | datamodel, | from,
 * | pivot). Keys are Model.Path (and Model.Name for a child named alone). */
export function datasetSearches(catalog: Catalog, model: Entity, d: Dataset): Entity[] {
  let index = searchIndex.get(catalog);
  if (!index) {
    index = new Map();
    for (const e of catalog.entities) {
      for (const k of e.lineage?.dataModelDatasets ?? []) index.set(k.toLowerCase(), [...(index.get(k.toLowerCase()) ?? []), e]);
    }
    searchIndex.set(catalog, index);
  }
  const keys = new Set([`${model.name}.${datasetPath(d)}`, `${model.name}.${d.name}`].map((k) => k.toLowerCase()));
  const out = new Map<string, Entity>();
  for (const k of keys) for (const e of index.get(k) ?? []) if (e.instance === model.instance) out.set(e.id, e);
  return [...out.values()];
}

const fieldIndex = new WeakMap<Catalog, Map<string, { model: Entity; datasets: string[] }[]>>();

/** Data models (and their datasets) with a field of this name, case-insensitive. */
export function dataModelsWithField(catalog: Catalog, name: string, instance?: string) {
  let index = fieldIndex.get(catalog);
  if (!index) {
    index = new Map();
    for (const m of catalog.entities) {
      if (m.type !== "dataModel") continue;
      const where = new Map<string, string[]>();
      for (const d of datasetsOf(m)) {
        for (const f of d.fields ?? []) {
          if (META.has(f)) continue;
          const k = f.toLowerCase();
          where.set(k, [...(where.get(k) ?? []), d.displayName ?? d.name]);
        }
      }
      for (const [k, datasets] of where) index.set(k, [...(index.get(k) ?? []), { model: m, datasets }]);
    }
    fieldIndex.set(catalog, index);
  }
  return (index.get(name.toLowerCase()) ?? []).filter((r) => !instance || r.model.instance === instance);
}
