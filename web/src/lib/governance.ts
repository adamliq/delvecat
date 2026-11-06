import type { Entity } from "../generated/catalog";

export interface EffectiveClassification {
  name: string;
  via?: string | null;
  derived: boolean;
  how: "annotated" | "field" | "sourcetype" | "lineage";
  sensitive: boolean;
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

type Gov = { classifications?: EffectiveClassification[]; access?: Access; sensitiveAccess?: SensitiveAccess[]; readsClassified?: string[] };
const gov = (e: Entity) => (e.governance ?? {}) as Gov;

export const effectiveClassifications = (e: Entity) => gov(e).classifications ?? [];
export const access = (e: Entity) => gov(e).access;
export const sensitiveAccess = (e: Entity) => gov(e).sensitiveAccess ?? [];
export const readsClassified = (e: Entity) => gov(e).readsClassified ?? [];
export const isSensitive = (e: Entity) => effectiveClassifications(e).some((c) => c.sensitive);

/** "PII.IPAddress" matches a "PII" filter. */
export const matchesClass = (name: string, filter: string) => !filter || name === filter || name.startsWith(`${filter}.`);

export const HOW_LABEL: Record<EffectiveClassification["how"], string> = {
  annotated: "annotated",
  field: "from a field",
  sourcetype: "from its sourcetype",
  lineage: "derived through lineage",
};
