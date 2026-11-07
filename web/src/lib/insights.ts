import type { Entity, EntityType } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { effectiveDescription, owners } from "./annotate";
import { applies, propertyDefs } from "./structured";

/** Types people are expected to document and own (not fields, hosts, users...). */
export const DOCUMENTED_TYPES = new Set<EntityType>([
  "index", "sourcetype", "savedSearch", "correlationSearch", "dashboard", "lookup", "kvCollection",
  "macro", "dataModel", "eventtype", "soarPlaybook", "dbInput", "dbOutput", "dbConnection", "uebaModel",
] as EntityType[]);

const vendorCache = new WeakMap<Catalog, Set<string>>();

/** Apps written by Splunk or belonging to a Splunk product (same rule as ingestion). */
export function vendorApps(catalog: Catalog): Set<string> {
  let apps = vendorCache.get(catalog);
  if (apps) return apps;
  apps = new Set(
    catalog.entities
      .filter((e) => e.type === "app")
      .filter((e) => {
        const p = (e.properties ?? {}) as { author?: unknown; builtin?: unknown };
        return String(p.author ?? "").toLowerCase().includes("splunk") || Boolean(p.builtin) || (e.product && e.product !== "splunk");
      })
      .map((e) => e.name),
  );
  vendorCache.set(catalog, apps);
  return apps;
}

export const isVendor = (catalog: Catalog, e: Entity) =>
  e.sharing === "system" || Boolean(e.usage?.builtin) || (e.app !== undefined && vendorApps(catalog).has(e.app));

export type Metric = "described" | "owned" | "inDomain" | "complete";

export const METRICS: { key: Metric; label: string }[] = [
  { key: "described", label: "Described" },
  { key: "owned", label: "Owned" },
  { key: "inDomain", label: "In a domain" },
  { key: "complete", label: "Required properties" },
];

export interface Coverage {
  group: string;
  total: number;
  /** metric -> [objects meeting it, objects it applies to] */
  counts: Record<Metric, [number, number]>;
}

export type GroupBy = "app" | "domain" | "type";

/** Documentation, ownership, domain and required-property coverage per group. */
export function coverageBy(catalog: Catalog, by: GroupBy, includeVendor: boolean): { overall: Coverage; groups: Coverage[] } {
  const required = propertyDefs(catalog.bundle).filter((d) => d.required);
  const objects = catalog.entities.filter((e) => DOCUMENTED_TYPES.has(e.type) && (includeVendor || !isVendor(catalog, e)));
  const empty = (group: string): Coverage => ({
    group, total: 0, counts: { described: [0, 0], owned: [0, 0], inDomain: [0, 0], complete: [0, 0] },
  });
  const groups = new Map<string, Coverage>();
  const overall = empty("All");
  for (const e of objects) {
    const key = by === "app" ? (e.app ?? "(no app)") : by === "domain" ? (e.annotations?.domain ?? "(no domain)") : e.type;
    const g = groups.get(key) ?? empty(key);
    groups.set(key, g);
    const needsProps = required.some((d) => applies(d, e));
    const marks: [Metric, boolean, boolean][] = [
      ["described", true, Boolean(effectiveDescription(e))],
      ["owned", true, owners(e).length > 0],
      ["inDomain", true, Boolean(e.annotations?.domain)],
      ["complete", needsProps, !(e.annotations?.missingProperties?.length)],
    ];
    for (const c of [g, overall]) {
      c.total++;
      for (const [m, applicable, ok] of marks) {
        if (!applicable) continue;
        c.counts[m][1]++;
        if (ok) c.counts[m][0]++;
      }
    }
  }
  return { overall, groups: [...groups.values()].sort((a, b) => b.total - a.total || a.group.localeCompare(b.group)) };
}

/** One usage number per object: runs, views, searches and ad-hoc references added up. */
export function usageScore(e: Entity): number | undefined {
  const u = e.usage;
  if (!u) return undefined;
  const parts = [u.runs, u.views, u.searches, u.adhocSearches, u.panelSearchRuns].filter((x): x is number => typeof x === "number");
  return parts.length ? parts.reduce((a, b) => a + b, 0) : 0;
}

export const USAGE_GROUPS: { label: string; types: EntityType[]; measure: string }[] = [
  { label: "Indexes", types: ["index"], measure: "searches referencing it" },
  { label: "Sourcetypes", types: ["sourcetype"], measure: "searches referencing it" },
  { label: "Searches and detections", types: ["savedSearch", "correlationSearch"], measure: "runs" },
  { label: "Dashboards", types: ["dashboard"], measure: "views" },
  { label: "Lookups and macros", types: ["lookup", "macro", "kvCollection"], measure: "searches referencing it" },
  { label: "Users", types: ["user"], measure: "searches run" },
] as { label: string; types: EntityType[]; measure: string }[];

/** The most used objects of some types, highest first (objects with no use left out). */
export function mostUsed(catalog: Catalog, types: EntityType[], limit = 10): { entity: Entity; score: number }[] {
  return catalog.entities
    .filter((e) => types.includes(e.type))
    .map((entity) => ({ entity, score: usageScore(entity) ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name))
    .slice(0, limit);
}

const pctCache = new WeakMap<Catalog, Map<string, number>>();

/**
 * Share of same-type objects (with usage data) that this one is used more than,
 * 0-100; undefined when there is no usage data or fewer than five to compare.
 */
export function usagePercentile(catalog: Catalog, e: Entity): number | undefined {
  let cache = pctCache.get(catalog);
  if (!cache) {
    cache = new Map();
    const byType = new Map<string, { id: string; score: number }[]>();
    for (const x of catalog.entities) {
      const score = usageScore(x);
      if (score === undefined) continue;
      const list = byType.get(x.type) ?? [];
      list.push({ id: x.id, score });
      byType.set(x.type, list);
    }
    for (const list of byType.values()) {
      if (list.length < 5) continue;
      for (const item of list) {
        const below = list.filter((o) => o.score < item.score).length;
        cache.set(item.id, Math.round((100 * below) / list.length));
      }
    }
    pctCache.set(catalog, cache);
  }
  return cache.get(e.id);
}
