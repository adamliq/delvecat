import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { hasLineage, impact, lineageGraph, upstreamOf } from "./lineage";

const ent = (type: EntityType, name: string): Entity => ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i" });
const E = (from: Entity, type: Edge["type"], to: Entity): Edge => ({ from: from.id, to: to.id, type });

const input = ent("input", "hec");
const index = ent("index", "web");
const summary = ent("index", "summary");
const macro = ent("macro", "m");
const rollup = ent("savedSearch", "rollup");
const report = ent("savedSearch", "report");
const dash = ent("dashboard", "d");
const app = ent("app", "a");
const lookup = ent("lookup", "kv");

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [input, index, summary, macro, rollup, report, dash, app, lookup],
  edges: [
    E(input, "feeds", index),
    E(rollup, "reads", index),
    E(rollup, "uses", macro),
    E(rollup, "writes", summary),
    E(report, "reads", summary),
    E(dash, "reads", report),
    E(app, "contains", rollup), // structural, not lineage
    E(report, "reads", lookup), // a read/write cycle on the lookup
    E(report, "writes", lookup),
  ],
};
const c = new Catalog(bundle);

describe("lineage", () => {
  it("follows data flow through reads, uses and writes", () => {
    expect(impact(c, index.id).map((e) => e.name).sort()).toEqual(["d", "kv", "report", "rollup", "summary"]);
    expect(upstreamOf(c, dash.id).map((e) => e.name).sort()).toEqual(["hec", "kv", "m", "report", "rollup", "summary", "web"]);
  });

  it("ignores structural edges", () => {
    expect(hasLineage(c, app.id)).toBe(false);
    expect(upstreamOf(c, rollup.id).map((e) => e.name).sort()).toEqual(["hec", "m", "web"]);
  });

  it("places nodes by signed distance and limits depth", () => {
    const g = lineageGraph(c, rollup.id, 1, 1);
    const levels = Object.fromEntries(g.nodes.map((n) => [n.entity.name, n.level]));
    expect(levels).toEqual({ rollup: 0, web: -1, m: -1, summary: 1 });
    expect(g.hasMoreUp).toBe(true); // hec feeds web, one hop further
    expect(g.hasMoreDown).toBe(true); // report reads summary
    expect(g.edges.map((e) => `${e.from.split(":")[2]}>${e.to.split(":")[2]}`).sort()).toEqual(["m>rollup", "rollup>summary", "web>rollup"]);
  });

  it("terminates on cycles", () => {
    const g = lineageGraph(c, report.id, 5, 5);
    expect(g.nodes.find((n) => n.entity.name === "kv")?.level).toBe(-1);
    expect(impact(c, lookup.id).map((e) => e.name).sort()).toEqual(["d", "report"]); // not itself
  });
});

describe("layout", () => {
  it("layers by longest path so sources sit left of what they feed", () => {
    const st = ent("sourcetype", "st");
    const idx = ent("index", "idx");
    const search = ent("savedSearch", "s");
    const board = ent("dashboard", "b");
    const cat = new Catalog({
      ...bundle,
      entities: [st, idx, search, board],
      edges: [E(st, "feeds", idx), E(search, "reads", idx), E(board, "reads", idx), E(board, "reads", search)],
    });
    const levels = Object.fromEntries(lineageGraph(cat, board.id, 3, 0).nodes.map((n) => [n.entity.name, n.level]));
    expect(levels).toEqual({ b: 0, s: -1, idx: -2, st: -3 });
  });
});
