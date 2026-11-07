import type { Entity, FieldLineage } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { flow } from "./lineage";

export type FieldHow = FieldLineage["used"][number]["how"][number];

export const HOW_LABELS: Record<FieldHow, string> = {
  filter: "filter",
  groupBy: "group by",
  aggregate: "aggregate",
  eval: "eval",
  rename: "rename",
  lookup: "lookup key",
  extract: "extract from",
  enrich: "enrich",
  join: "join key",
  dedup: "dedup",
  sort: "sort",
  select: "select",
  output: "output",
};

export const SOURCE_LABELS: Record<FieldLineage["source"], string> = {
  events: "fields of the events it searches",
  datamodel: "data model fields",
  lookup: "lookup fields",
  search: "columns of another search's results",
  database: "database columns",
  metrics: "metric dimensions",
  other: "fields of generated results",
};

/** The field name of a ``field`` entity ("acme:fw/src_ip" -> "src_ip"). */
export function fieldName(f: Entity): string {
  const p = (f.properties ?? {}) as { field?: unknown };
  return typeof p.field === "string" ? p.field : (f.displayName ?? f.name.split("/").pop() ?? f.name);
}

const edgeTargets = (catalog: Catalog, id: string, type: string) =>
  catalog.edgesFrom(id).filter((x) => x.type === type).map((x) => catalog.byId.get(x.to)).filter((e): e is Entity => Boolean(e));
const edgeSources = (catalog: Catalog, id: string, type: string) =>
  catalog.edgesTo(id).filter((x) => x.type === type).map((x) => catalog.byId.get(x.from)).filter((e): e is Entity => Boolean(e));

export interface UsedField {
  name: string;
  how: FieldHow[];
  fields: Entity[]; // the sourcetype fields it was matched to
}

/** Fields a search uses, each with the sourcetype fields it resolved to. */
export function usedFields(catalog: Catalog, e: Entity): UsedField[] {
  const fl = e.lineage?.fields;
  if (!fl) return [];
  const resolved = edgeTargets(catalog, e.id, "readsField");
  return fl.used.map((u) => ({ name: u.name, how: u.how, fields: resolved.filter((f) => fieldName(f) === u.name) }));
}

const DEFINER_TYPES = new Set(["fieldExtraction", "fieldAlias", "calculatedField", "automaticLookup"]);

/** Alias pairs of a field alias: original field -> alias names. */
function aliasPairs(d: Entity): Map<string, string[]> {
  const aliases = ((d.properties ?? {}) as { aliases?: Record<string, unknown> }).aliases ?? {};
  const out = new Map<string, string[]>();
  for (const [k, v] of Object.entries(aliases)) {
    const original = k.replace(/^\d+\./, "");
    out.set(original, [...(out.get(original) ?? []), ...String(v).split(/\s+/).filter(Boolean)]);
  }
  return out;
}

/** Fields a configuration object derives from one of the fields it reads. */
export function derives(catalog: Catalog, definer: Entity, from: Entity): Entity[] {
  const defined = edgeTargets(catalog, definer.id, "definesField");
  if (definer.type !== "fieldAlias") return defined;
  const names = aliasPairs(definer).get(fieldName(from)) ?? [];
  return defined.filter((f) => names.includes(fieldName(f)));
}

export interface FieldReader {
  entity: Entity;
  how: FieldHow[]; // empty for configuration (aliases, calculated fields, lookups)
  defines: Entity[]; // fields a configuration object derives from this one
}

/** Objects that read a field: searches (with how) and configuration deriving other fields from it. */
export function fieldReaders(catalog: Catalog, field: Entity): FieldReader[] {
  const name = fieldName(field);
  return edgeSources(catalog, field.id, "readsField")
    .map((entity) => ({
      entity,
      how: entity.lineage?.fields?.used.find((u) => u.name === name)?.how ?? [],
      defines: derives(catalog, entity, field),
    }))
    .sort((a, b) => a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
}

/** Configuration that defines a field (extractions, aliases, calculated fields, automatic lookups). */
export const fieldDefiners = (catalog: Catalog, field: Entity) => edgeSources(catalog, field.id, "definesField");

/** Fields a field is derived from, through the configuration that defines it. */
export function derivedFrom(catalog: Catalog, field: Entity): Entity[] {
  const out = new Map<string, Entity>();
  for (const d of fieldDefiners(catalog, field)) {
    for (const f of edgeTargets(catalog, d.id, "readsField")) {
      if (f.id !== field.id && derives(catalog, d, f).some((x) => x.id === field.id)) out.set(f.id, f);
    }
  }
  return [...out.values()];
}

export interface Affected {
  entity: Entity;
  depth: number;
  via?: Entity;
}

/**
 * What a change to a field could break: objects that read it, fields derived
 * from it (aliases, calculated fields, lookup outputs) and their readers, and
 * everything downstream of those in lineage.
 */
export function fieldImpact(catalog: Catalog, field: Entity, maxDepth = 10): Affected[] {
  const down = flow(catalog).down;
  // Configuration (aliases, calculated fields, lookups) only passes a change on to the
  // fields it derives from this one; searches pass it on to everything downstream.
  const next = (id: string, parent?: string): string[] => {
    const e = catalog.byId.get(id);
    if (!e) return [];
    if (e.type === "field") return catalog.edgesTo(id).filter((x) => x.type === "readsField").map((x) => x.from);
    if (DEFINER_TYPES.has(e.type)) {
      const from = parent ? catalog.byId.get(parent) : undefined;
      return from ? derives(catalog, e, from).map((f) => f.id) : [];
    }
    return (down.get(id) ?? []).map((x) => x.to);
  };
  const seen = new Map<string, Affected>();
  const parents = new Map<string, string>();
  let frontier = [field.id];
  const visited = new Set(frontier);
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      for (const n of next(id, parents.get(id))) {
        if (visited.has(n)) continue;
        visited.add(n);
        const entity = catalog.byId.get(n);
        if (!entity) continue;
        parents.set(n, id);
        seen.set(n, { entity, depth, via: depth > 1 ? catalog.byId.get(id) : undefined });
        nextFrontier.push(n);
      }
    }
    frontier = nextFrontier;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth || a.entity.name.localeCompare(b.entity.name));
}
