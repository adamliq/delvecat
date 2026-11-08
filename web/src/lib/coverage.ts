import type { Entity } from "../generated/catalog";
import { staticBase } from "./splunkSource";
import type { Catalog } from "./catalog";
import { anyUpstream } from "./lineage";

export interface AttackData {
  version?: string;
  attribution: string;
  tactics: { id: string; shortname: string; name: string }[];
  techniques: { id: string; name: string; tactics: string[]; parent?: string }[];
}

export type DetectionState = "ready" | "disabled" | "broken" | "noData";

export const STATE_LABELS: Record<DetectionState, string> = {
  ready: "Can fire",
  disabled: "Disabled",
  broken: "Broken reference",
  noData: "No data feeding it",
};

export interface DetectionStatus {
  entity: Entity;
  state: DetectionState;
  techniques: string[];
  dataModels: string[];
}

const props = (e: Entity) => (e.properties ?? {}) as Record<string, unknown>;
const observed = (e: Entity) => (props(e).observed ?? {}) as Record<string, unknown>;

export function isDetection(e: Entity): boolean {
  return e.type === "correlationSearch" || (Array.isArray(props(e).mitreAttack) && (props(e).mitreAttack as unknown[]).length > 0);
}

/** Does real data flow into this detection (an upstream index or sourcetype with events)? */
function hasData(catalog: Catalog, e: Entity): boolean {
  return anyUpstream(catalog, e.id, 10, (u) => {
    const o = observed(u);
    if (u.type === "index") return Number(o.totalEventCount ?? 0) > 0;
    if (u.type === "sourcetype") return Number(o.eventCount ?? 0) > 0;
    return false;
  });
}

const statusCache = new WeakMap<Catalog, Map<string, DetectionStatus>>();

/** Whether a detection can fire, cached per catalog (Home and Coverage both ask). */
export function detectionStatus(catalog: Catalog, e: Entity): DetectionStatus {
  let cache = statusCache.get(catalog);
  if (!cache) statusCache.set(catalog, (cache = new Map()));
  const hit = cache.get(e.id);
  if (hit) return hit;
  const s = computeStatus(catalog, e);
  cache.set(e.id, s);
  return s;
}

function computeStatus(catalog: Catalog, e: Entity): DetectionStatus {
  const techniques = ((props(e).mitreAttack ?? []) as string[]).map((t) => t.toUpperCase());
  const dataModels = catalog.edgesFrom(e.id)
    .filter((x) => x.type === "reads" && catalog.byId.get(x.to)?.type === "dataModel")
    .map((x) => catalog.byId.get(x.to)!.name);
  for (const u of e.lineage?.unresolved ?? []) if (u.startsWith("dataModel:")) dataModels.push(u.slice(10));
  let state: DetectionState = "ready";
  if (e.disabled) state = "disabled";
  else if (e.lineage?.unresolved?.length) state = "broken";
  else if (!hasData(catalog, e)) state = "noData";
  return { entity: e, state, techniques, dataModels };
}

export type CellState = "covered" | "weak" | "none";

export interface TechniqueCell {
  id: string;
  name: string;
  state: CellState;
  detections: DetectionStatus[];
  subtechniques: number;
}

export interface Coverage {
  detections: DetectionStatus[];
  columns: { tactic: AttackData["tactics"][number]; cells: TechniqueCell[] }[];
  topLevelTotal: number;
  topLevelCovered: number;
  topLevelWeak: number;
  unknownTechniques: string[];
}

/** ATT&CK coverage: a top-level technique is covered when a detection that can fire maps
 * to it or to one of its sub-techniques; weak when detections exist but none can fire. */
export function coverage(catalog: Catalog, attack: AttackData): Coverage {
  const detections = catalog.entities.filter(isDetection).map((e) => detectionStatus(catalog, e));
  const known = new Set(attack.techniques.map((t) => t.id));
  const byTop = new Map<string, DetectionStatus[]>();
  const unknown = new Set<string>();
  for (const d of detections) {
    for (const t of d.techniques) {
      if (!known.has(t)) unknown.add(t);
      const top = t.split(".")[0];
      const list = byTop.get(top) ?? [];
      if (!list.includes(d)) list.push(d);
      byTop.set(top, list);
    }
  }
  const subCount = new Map<string, number>();
  for (const t of attack.techniques) if (t.parent) subCount.set(t.parent, (subCount.get(t.parent) ?? 0) + 1);
  const cellFor = (t: AttackData["techniques"][number]): TechniqueCell => {
    const ds = byTop.get(t.id) ?? [];
    const state: CellState = ds.some((d) => d.state === "ready") ? "covered" : ds.length ? "weak" : "none";
    return { id: t.id, name: t.name, state, detections: ds, subtechniques: subCount.get(t.id) ?? 0 };
  };
  const top = attack.techniques.filter((t) => !t.parent);
  const cells = new Map(top.map((t) => [t.id, cellFor(t)]));
  const columns = attack.tactics.map((tactic) => ({
    tactic,
    cells: top.filter((t) => t.tactics.includes(tactic.shortname)).map((t) => cells.get(t.id)!)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const all = [...cells.values()];
  return {
    detections,
    columns,
    topLevelTotal: all.length,
    topLevelCovered: all.filter((c) => c.state === "covered").length,
    topLevelWeak: all.filter((c) => c.state === "weak").length,
    unknownTechniques: [...unknown].sort(),
  };
}

export interface DataModelCoverage {
  name: string;
  entity?: Entity;
  accelerated: boolean;
  hasData: boolean;
  detections: DetectionStatus[];
}

/** CIM data models that detections depend on, and whether data reaches them. */
export function dataModelCoverage(catalog: Catalog, detections: DetectionStatus[]): DataModelCoverage[] {
  const names = new Set(detections.flatMap((d) => d.dataModels));
  return [...names].sort().map((name) => {
    const entity = catalog.entities.find((e) => e.type === "dataModel" && e.name === name);
    return {
      name,
      entity,
      accelerated: Boolean(entity && props(entity).accelerated),
      hasData: Boolean(entity && hasData(catalog, entity)),
      detections: detections.filter((d) => d.dataModels.includes(name)),
    };
  });
}

export async function loadAttack(): Promise<AttackData> {
  const resp = await fetch(`${staticBase()}reference/attack-enterprise.json`);
  if (!resp.ok) throw new Error(`Could not load ATT&CK reference data (HTTP ${resp.status}).`);
  return resp.json();
}
