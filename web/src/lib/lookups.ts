import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

type Props = { fields?: unknown; fieldsFrom?: unknown; kind?: unknown };

/** Field names of a lookup (definition or file) or KV Store collection, in their order. */
export function lookupColumns(e: Entity): string[] {
  if (e.type !== "lookup" && e.type !== "kvCollection") return [];
  const f = ((e.properties ?? {}) as Props).fields;
  if (Array.isArray(f)) return f.map(String);
  if (f && typeof f === "object") return Object.keys(f);
  return [];
}

/** Declared type of a KV Store collection field (string, number, bool, time, cidr...). */
export function columnType(e: Entity, name: string): string | undefined {
  const f = ((e.properties ?? {}) as Props).fields;
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const t = (f as Record<string, unknown>)[name];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

/** Where a lookup's field list came from: its definition, its file's header row, or the
 * file / collection behind it (an object id). */
export function columnsSource(e: Entity): string | undefined {
  const f = ((e.properties ?? {}) as Props).fieldsFrom;
  return typeof f === "string" ? f : undefined;
}

/** Lookups and collections that are schemas of their own: not copies of another object's
 * field list (a file read through its definition), and with at least one field. */
export function isLookupSchema(e: Entity): boolean {
  const from = columnsSource(e);
  return lookupColumns(e).length > 0 && (!from || from === "header");
}

const schemaCache = new WeakMap<Catalog, Entity[]>();

export function schemaLookups(catalog: Catalog): Entity[] {
  let out = schemaCache.get(catalog);
  if (!out) {
    out = catalog.entities.filter(isLookupSchema).sort((a, b) => a.name.localeCompare(b.name));
    schemaCache.set(catalog, out);
  }
  return out;
}

const byFieldCache = new WeakMap<Catalog, Map<string, Entity[]>>();

/** Lookups and KV Store collections with a field of this name (case-insensitive), on the
 * given instance when one is named. */
export function lookupsWithField(catalog: Catalog, name: string, instance?: string): Entity[] {
  let index = byFieldCache.get(catalog);
  if (!index) {
    index = new Map();
    for (const e of schemaLookups(catalog)) {
      for (const c of lookupColumns(e)) {
        const k = c.toLowerCase();
        const list = index.get(k) ?? [];
        list.push(e);
        index.set(k, list);
      }
    }
    byFieldCache.set(catalog, index);
  }
  return (index.get(name.toLowerCase()) ?? []).filter((e) => !instance || e.instance === instance);
}

/** A lookup's fields as field-like objects, so the schema views (similar schemas, compare)
 * can treat a lookup like a sourcetype. Each links to the lookup itself. */
export function lookupFieldEntities(e: Entity): Entity[] {
  return lookupColumns(e).map((name) => {
    const t = columnType(e, name);
    const numeric = t === undefined ? undefined : t === "number";
    return {
      id: e.id,
      type: "field",
      name: `${e.name}/${name}`,
      displayName: name,
      product: e.product,
      instance: e.instance,
      properties: { field: name, ...(numeric === undefined ? {} : { numeric }), lookup: e.id },
    } as Entity;
  });
}
