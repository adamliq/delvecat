import type { EdgeType, Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

/**
 * "At risk" objects depend, directly or through other objects, on something
 * with a problem: a health finding, a broken reference or a disabled object.
 *
 * Risk follows dependency, which mostly matches data flow (a search depends on
 * the index it reads; a summary index on the search that writes it). Triggers
 * are the exception: a detection depends on the alert action it triggers, not
 * the other way round, so a disabled detection does not put a shared action at
 * risk, but a broken action puts every detection that triggers it at risk.
 *
 * When a target has several producers of the same kind (an index fed by many
 * sourcetypes, or written by many searches), one bad producer only partly
 * affects it: the target is flagged as a warning and the risk goes no further.
 * A disabled producer there is ignored, since disabling is usually deliberate.
 */
const DEPENDS: Partial<Record<EdgeType, "fromNeedsTo" | "toNeedsFrom">> = {
  reads: "fromNeedsTo",
  uses: "fromNeedsTo",
  mapsTo: "fromNeedsTo",
  triggers: "fromNeedsTo",
  feeds: "toNeedsFrom",
  writes: "toNeedsFrom",
  accelerates: "toNeedsFrom",
  deploys: "toNeedsFrom",
};

export type Severity = "warning" | "critical";

export interface Problem {
  kind: "health" | "brokenReference" | "disabled";
  severity: Severity;
  summary: string;
}

export interface RiskCause {
  root: Entity;
  problems: Problem[];
  depth: number; // 1 = direct dependency
  partial?: boolean; // one of several producers of the object
  via?: Entity; // the dependency it comes through (depth > 1)
}

export interface Risk {
  severity: Severity;
  causes: RiskCause[];
}

const MAX_DEPTH = 10;

/** An object's own problems, the ones that put what depends on it at risk. */
export function problems(e: Entity): Problem[] {
  const out: Problem[] = [];
  for (const c of e.health?.checks ?? []) {
    if (c.status !== "ok") out.push({ kind: "health", severity: c.status, summary: c.message || c.check });
  }
  const missing = e.lineage?.unresolved ?? [];
  if (missing.length) {
    out.push({ kind: "brokenReference", severity: "warning", summary: `missing ${missing.join(", ")}` });
  }
  if (e.disabled) out.push({ kind: "disabled", severity: "warning", summary: "disabled" });
  return out;
}

const worst = (a: Severity, b: Severity): Severity => (a === "critical" || b === "critical" ? "critical" : "warning");

const cache = new WeakMap<Catalog, Map<string, Risk>>();

/** Every at-risk object, with what puts it at risk. Computed once per catalog. */
export function riskMap(catalog: Catalog): Map<string, Risk> {
  const cached = cache.get(catalog);
  if (cached) return cached;

  // dependents: id -> objects that depend on it
  const dependents = new Map<string, { dep: string; producerKey?: string }[]>();
  const producers = new Map<string, number>(); // "target|edge type" -> producer count
  const add = (dep: string, on: string, producerKey?: string) => {
    if (dep === on) return;
    const list = dependents.get(on);
    if (list) list.push({ dep, producerKey });
    else dependents.set(on, [{ dep, producerKey }]);
  };
  for (const e of catalog.bundle.edges) {
    const d = DEPENDS[e.type];
    if (d === "fromNeedsTo") add(e.from, e.to);
    else if (d === "toNeedsFrom") {
      const key = `${e.to}|${e.type}`;
      producers.set(key, (producers.get(key) ?? 0) + 1);
      add(e.to, e.from, key);
    }
  }
  const shared = (key?: string) => key !== undefined && (producers.get(key) ?? 0) > 1;

  const out = new Map<string, Risk>();
  for (const root of catalog.entities) {
    const own = problems(root);
    if (!own.length || !dependents.has(root.id)) continue;
    const severity = own.reduce<Severity>((s, p) => worst(s, p.severity), "warning");
    const onlyDisabled = own.every((p) => p.kind === "disabled");
    const seen = new Map<string, string | undefined>([[root.id, undefined]]);
    let frontier = [root.id];
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { dep, producerKey } of dependents.get(id) ?? []) {
          if (seen.has(dep)) continue;
          const partial = shared(producerKey);
          if (partial && onlyDisabled) continue;
          const entity = catalog.byId.get(dep);
          seen.set(dep, id);
          // A disabled object is a cause in its own right; nothing runs through it.
          if (!entity || entity.disabled) continue;
          const via = depth > 1 ? catalog.byId.get(id) : undefined;
          const level: Severity = partial ? "warning" : severity;
          const risk = out.get(dep) ?? { severity: level, causes: [] };
          risk.severity = worst(risk.severity, level);
          risk.causes.push({ root, problems: own, depth, via, ...(partial ? { partial } : {}) });
          out.set(dep, risk);
          if (!partial) next.push(dep);
        }
      }
      frontier = next;
    }
  }
  for (const r of out.values()) {
    r.causes.sort((a, b) => a.depth - b.depth || a.root.name.localeCompare(b.root.name));
  }
  cache.set(catalog, out);
  return out;
}

/** Objects put at risk by one object's problems (its "blast radius"). */
export function atRiskFrom(catalog: Catalog, rootId: string): { entity: Entity; cause: RiskCause }[] {
  const out: { entity: Entity; cause: RiskCause }[] = [];
  for (const [id, r] of riskMap(catalog)) {
    const cause = r.causes.find((c) => c.root.id === rootId);
    const entity = catalog.byId.get(id);
    if (cause && entity) out.push({ entity, cause });
  }
  return out.sort((a, b) => a.cause.depth - b.cause.depth || a.entity.name.localeCompare(b.entity.name));
}
