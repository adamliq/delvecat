import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import type { FacetFn } from "./search";

export type PropertyDef = NonNullable<Catalog["bundle"]["structuredProperties"]>[number];
export type PropValueT = string | number | boolean | (string | number | boolean)[];

export const propertyDefs = (bundle: { structuredProperties?: PropertyDef[] }) => bundle.structuredProperties ?? [];
export const propertyValues = (e: Entity) => (e.annotations?.properties ?? {}) as Record<string, PropValueT>;
export const label = (d: PropertyDef) => d.displayName ?? d.id;

const asList = (v: PropValueT): (string | number | boolean)[] => (Array.isArray(v) ? v : [v]);

/** Values as filter strings (booleans read as Yes / No). */
export function valueStrings(v: PropValueT): string[] {
  return asList(v).map((x) => (typeof x === "boolean" ? (x ? "Yes" : "No") : String(x)));
}

/** One search facet per structured property marked showInFilters. */
export function propertyFacets(defs: PropertyDef[]): Record<string, FacetFn> {
  const out: Record<string, FacetFn> = {};
  for (const d of defs) {
    if (!d.showInFilters) continue;
    out[`p.${d.id}`] = (e) => {
      const v = propertyValues(e)[d.id];
      return v === undefined ? [] : valueStrings(v);
    };
  }
  return out;
}

export function allowedDescription(d: PropertyDef, value: string | number | boolean): string | undefined {
  for (const a of (d.allowedValues ?? []) as unknown[]) {
    if (a && typeof a === "object" && "value" in a && (a as { value: unknown }).value === value) {
      return (a as { description?: string }).description;
    }
  }
  return undefined;
}

/** Applicable objects for a definition and how many have a value. */
export function coverage(entities: Entity[], d: PropertyDef) {
  const applicable = entities.filter((e) => applies(d, e));
  const filled = applicable.filter((e) => propertyValues(e)[d.id] !== undefined);
  const missing = entities.filter((e) => e.annotations?.missingProperties?.includes(d.id));
  return { applicable: applicable.length, filled: filled.length, missing: missing.length };
}

export const applies = (d: PropertyDef, e: Entity) => !d.appliesTo?.length || d.appliesTo.includes(e.type);

/** Display form: Yes / No for booleans, locale date for dates. */
export function formatValue(d: PropertyDef, v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (d.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const date = new Date(v.length === 10 ? `${v}T00:00:00` : v);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString();
  }
  return String(v);
}

/** "Label: value" strings for properties marked showInSummary. */
export function summaryChips(defs: PropertyDef[], e: Entity): { id: string; text: string }[] {
  const values = propertyValues(e);
  return defs
    .filter((d) => d.showInSummary && values[d.id] !== undefined)
    .map((d) => ({ id: d.id, text: `${label(d)}: ${asList(values[d.id]).map((x) => formatValue(d, x)).join(", ")}` }));
}
