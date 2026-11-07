import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

export interface EffectiveClassification {
  name: string;
  via?: string | null;
  derived: boolean;
  how: "annotated" | "field" | "derivedField" | "sourcetype" | "lineage";
  sensitive: boolean;
  /** The columns that hold it; absent when the whole object is classified. */
  columns?: string[];
}

export interface Access {
  roles: string[];
  filteredRoles: string[];
  users: string[];
  everyone: boolean;
}

export interface SensitiveAccess {
  id: string;
  classifications: string[];
  how: "search" | "read";
  filtered?: boolean;
  viaRoles?: string[];
}

type Gov = {
  classifications?: EffectiveClassification[];
  access?: Access;
  sensitiveAccess?: SensitiveAccess[];
  readsClassified?: string[];
  stops?: string[];
};
const gov = (e: Entity) => (e.governance ?? {}) as Gov;

export const effectiveClassifications = (e: Entity) => gov(e).classifications ?? [];
export const access = (e: Entity) => gov(e).access;
const userReach = new WeakMap<Catalog, Map<string, SensitiveAccess[]>>();

/**
 * Sensitive data an object can reach. Roles carry it (inherited roles included);
 * a user's is the union of their roles', derived here rather than stored on every
 * user (older bundles that stored it still work).
 */
export function sensitiveAccess(e: Entity, catalog?: Catalog): SensitiveAccess[] {
  const own = gov(e).sensitiveAccess;
  if (own || e.type !== "user" || !catalog) return own ?? [];
  let cache = userReach.get(catalog);
  if (!cache) userReach.set(catalog, (cache = new Map()));
  let reach = cache.get(e.id);
  if (!reach) {
    const byStore = new Map<string, SensitiveAccess>();
    const roles = catalog.edgesFrom(e.id).filter((x) => x.type === "memberOf").map((x) => x.to).sort();
    for (const rid of roles) {
      const role = catalog.byId.get(rid);
      for (const a of role ? gov(role).sensitiveAccess ?? [] : []) {
        const item = byStore.get(a.id) ?? { ...a, viaRoles: [] };
        item.viaRoles = [...(item.viaRoles ?? []), rid];
        byStore.set(a.id, item);
      }
    }
    reach = [...byStore.values()].sort((a, b) => a.id.localeCompare(b.id));
    cache.set(e.id, reach);
  }
  return reach;
}
export const readsClassified = (e: Entity) => gov(e).readsClassified ?? [];
/** Classifications this object reads but does not pass on (stopsClassifications). */
export const stoppedClassifications = (e: Entity) => gov(e).stops ?? [];
export const isSensitive = (e: Entity) => effectiveClassifications(e).some((c) => c.sensitive);

/** "PII.IPAddress" matches a "PII" filter. */
export const matchesClass = (name: string, filter: string) => !filter || name === filter || name.startsWith(`${filter}.`);

export const HOW_LABEL: Record<EffectiveClassification["how"], string> = {
  annotated: "annotated",
  field: "from a field",
  derivedField: "derived from a field",
  sourcetype: "from its sourcetype",
  lineage: "derived through lineage",
};
