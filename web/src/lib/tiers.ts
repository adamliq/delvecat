/** Deployment servers in tiers: a second-tier server takes apps from an upstream one and
 * passes them on to its own forwarders (joined when the builds are merged). */
import type { Catalog } from "./catalog";
import type { Entity, Instance } from "../generated/catalog";

export interface TierFacts {
  tier?: number;
  upstream?: string;
  upstreamInstance?: string;
  relaysApps?: boolean;
  receivedApps?: string[];
}

export function tierFacts(inst: Instance | undefined): TierFacts | undefined {
  const p = (inst?.properties ?? {}) as Record<string, unknown>;
  const dc = (p.deploymentClient ?? {}) as Record<string, unknown>;
  const tier = typeof p.deploymentTier === "number" ? p.deploymentTier : undefined;
  if (tier === undefined && !dc.upstream) return undefined;
  return {
    tier,
    upstream: typeof dc.upstream === "string" ? dc.upstream : undefined,
    upstreamInstance: typeof dc.upstreamInstance === "string" ? dc.upstreamInstance : undefined,
    relaysApps: typeof dc.relaysApps === "boolean" ? dc.relaysApps : undefined,
    receivedApps: Array.isArray(dc.receivedApps) ? (dc.receivedApps as string[]) : undefined,
  };
}

/** "Deployment server, tier 2 (from acme-ds)" for an instance card, or undefined. */
export function tierLabel(catalog: Catalog, inst: Instance): string | undefined {
  const t = tierFacts(inst);
  if (!t) return undefined;
  const up = t.upstreamInstance ? instName(catalog, t.upstreamInstance) : t.upstream;
  if (t.tier === undefined) return `Deployment server, takes apps from ${up}`;
  return `Deployment server, tier ${t.tier}${t.tier > 1 && up ? ` (from ${up})` : ""}`;
}

export const instName = (catalog: Catalog, id: string) =>
  catalog.bundle.instances.find((i) => i.id === id)?.name ?? id;

/** Downstream copies of an upstream deployment app (other tiers). */
export function passedOnTo(catalog: Catalog, app: Entity): Entity[] {
  return catalog
    .edgesFrom(app.id)
    .filter((e) => e.type === "deploys")
    .map((e) => catalog.byId.get(e.to))
    .filter((e): e is Entity => !!e && e.type === "deploymentApp" && e.instance !== app.instance);
}
