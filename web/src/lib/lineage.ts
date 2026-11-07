import type { EdgeType, Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

/**
 * Lineage follows data flow. "feeds" and "writes" point downstream already;
 * "reads", "uses" and "mapsTo" point from the consumer to its source, so they
 * are reversed. Structural edges (contains, memberOf, grantsAccess, ...) are not
 * lineage.
 */
const FLOW: Partial<Record<EdgeType, "forward" | "reverse">> = {
  feeds: "forward",
  writes: "forward",
  triggers: "forward",
  accelerates: "forward",
  deploys: "forward",
  reads: "reverse",
  uses: "reverse",
  mapsTo: "reverse",
};

export interface FlowEdge {
  from: string; // upstream
  to: string; // downstream
  type: EdgeType;
}

interface Flow {
  down: Map<string, FlowEdge[]>;
  up: Map<string, FlowEdge[]>;
}

const cache = new WeakMap<Catalog, Flow>();

export function flow(catalog: Catalog): Flow {
  let f = cache.get(catalog);
  if (f) return f;
  f = { down: new Map(), up: new Map() };
  for (const e of catalog.bundle.edges) {
    const dir = FLOW[e.type];
    if (!dir) continue;
    const fe: FlowEdge = dir === "forward" ? { from: e.from, to: e.to, type: e.type } : { from: e.to, to: e.from, type: e.type };
    if (fe.from === fe.to) continue;
    (f.down.get(fe.from) ?? f.down.set(fe.from, []).get(fe.from)!).push(fe);
    (f.up.get(fe.to) ?? f.up.set(fe.to, []).get(fe.to)!).push(fe);
  }
  cache.set(catalog, f);
  return f;
}

function walk(map: Map<string, FlowEdge[]>, start: string, depth: number, next: (e: FlowEdge) => string) {
  const level = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      for (const e of map.get(id) ?? []) {
        const n = next(e);
        if (!level.has(n)) {
          level.set(n, d);
          nextFrontier.push(n);
        }
      }
    }
    frontier = nextFrontier;
  }
  level.delete(start);
  return level;
}

export interface LineageGraph {
  nodes: { entity: Entity; level: number }[];
  edges: FlowEdge[];
  hasMoreUp: boolean;
  hasMoreDown: boolean;
}

/** Nodes within `up`/`down` hops; level < 0 upstream, 0 the entity, > 0 downstream. */
export function lineageGraph(catalog: Catalog, id: string, up: number, down: number): LineageGraph {
  const f = flow(catalog);
  const upstream = walk(f.up, id, up, (e) => e.from);
  const downstream = walk(f.down, id, down, (e) => e.to);
  const levels = new Map<string, number>([[id, 0]]);
  upstream.forEach((d, n) => levels.set(n, -d));
  downstream.forEach((d, n) => {
    if (!levels.has(n)) levels.set(n, d);
  });
  const nodes = [...levels.entries()]
    .map(([n, level]) => ({ entity: catalog.byId.get(n)!, level }))
    .filter((n) => n.entity);
  const ids = new Set(nodes.map((n) => n.entity.id));
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const n of ids) {
    for (const e of f.down.get(n) ?? []) {
      const key = `${e.from}|${e.to}|${e.type}`;
      if (ids.has(e.to) && !seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
  }
  // Layer by longest path so every source sits left of what it feeds (bounded for cycles).
  const level = new Map(nodes.map((n) => [n.entity.id, n.level]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const lf = level.get(e.from)!, lt = level.get(e.to)!;
      if (lf < 0 && lt <= 0 && lf > lt - 1) {
        level.set(e.from, lt - 1);
        changed = true;
      } else if (lt > 0 && lf >= 0 && lt < lf + 1) {
        level.set(e.to, lf + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  nodes.forEach((n) => (n.level = level.get(n.entity.id)!));

  const edgeOf = (map: Map<string, FlowEdge[]>, levelsAt: Map<string, number>, depth: number, next: (e: FlowEdge) => string) =>
    [...levelsAt.entries()].some(([n, d]) => d === depth && (map.get(n) ?? []).some((e) => !levels.has(next(e))));
  return {
    nodes,
    edges,
    hasMoreUp: edgeOf(f.up, upstream, up, (e) => e.from),
    hasMoreDown: edgeOf(f.down, downstream, down, (e) => e.to),
  };
}

/** Everything downstream of an entity (what could break if it changes). */
export function impact(catalog: Catalog, id: string, maxDepth = 20): Entity[] {
  const down = walk(flow(catalog).down, id, maxDepth, (e) => e.to);
  return [...down.keys()].map((n) => catalog.byId.get(n)!).filter(Boolean);
}

export interface Reached {
  entity: Entity;
  depth: number;
  via?: Entity; // the object it was reached through (undefined at depth 1)
}

/** Everything reachable downstream ("impact") or upstream, with hop count and path. */
export function reach(catalog: Catalog, id: string, direction: "down" | "up", maxDepth = 20): Reached[] {
  const f = flow(catalog);
  const map = direction === "down" ? f.down : f.up;
  const next = (e: FlowEdge) => (direction === "down" ? e.to : e.from);
  const seen = new Map<string, { depth: number; via?: string }>([[id, { depth: 0 }]]);
  let frontier = [id];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const nextFrontier: string[] = [];
    for (const n of frontier) {
      for (const e of map.get(n) ?? []) {
        const m = next(e);
        if (!seen.has(m)) {
          seen.set(m, { depth: d, via: n === id ? undefined : n });
          nextFrontier.push(m);
        }
      }
    }
    frontier = nextFrontier;
  }
  seen.delete(id);
  return [...seen.entries()]
    .map(([n, s]) => ({ entity: catalog.byId.get(n)!, depth: s.depth, via: s.via ? catalog.byId.get(s.via) : undefined }))
    .filter((r) => r.entity)
    .sort((a, b) => a.depth - b.depth || a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
}

export function upstreamOf(catalog: Catalog, id: string, maxDepth = 20): Entity[] {
  const up = walk(flow(catalog).up, id, maxDepth, (e) => e.from);
  return [...up.keys()].map((n) => catalog.byId.get(n)!).filter(Boolean);
}

export function hasLineage(catalog: Catalog, id: string): boolean {
  const f = flow(catalog);
  return Boolean(f.up.get(id)?.length || f.down.get(id)?.length);
}
