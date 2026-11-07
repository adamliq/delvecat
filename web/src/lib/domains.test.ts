import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { boundary, domainAssets, rollup, subtree } from "./domains";
import { reach } from "./lineage";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const E = (a: Entity, type: Edge["type"], b: Entity): Edge => ({ from: a.id, to: b.id, type });

const host = ent("host", "web01");
const idx = ent("index", "web", { annotations: { domain: "Web", description: "logs" }, health: { status: "warning", checks: [] } });
const rollupSearch = ent("savedSearch", "rollup", { annotations: { domain: "Web Analytics" } });
const summary = ent("index", "summary", { annotations: { domain: "Web Analytics" }, usage: { unused: true } });
const board = ent("dashboard", "board", { annotations: { domain: "Security" } });

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [host, idx, rollupSearch, summary, board],
  edges: [E(host, "feeds", idx), E(rollupSearch, "reads", idx), E(rollupSearch, "writes", summary), E(board, "reads", summary)],
  domains: [{ name: "Web" }, { name: "Web Analytics", parent: "Web" }, { name: "Security" }, { name: "Loop", parent: "Loop" }],
  dataProducts: [{ name: "Storefront", domain: "Web", assets: [idx.id, rollupSearch.id, summary.id, "i:index:gone"] }],
};
const c = new Catalog(bundle);

describe("domains", () => {
  it("includes sub-domains and survives cycles", () => {
    expect([...subtree(c, "Web")].sort()).toEqual(["Web", "Web Analytics"]);
    expect([...subtree(c, "Loop")]).toEqual(["Loop"]);
    expect(domainAssets(c, "Web").map((e) => e.name).sort()).toEqual(["rollup", "summary", "web"]);
    expect(domainAssets(c, "Web", false).map((e) => e.name)).toEqual(["web"]);
  });

  it("rolls up health, documentation and cleanup", () => {
    expect(rollup(domainAssets(c, "Web"))).toEqual({ total: 3, critical: 0, warning: 1, sensitive: 0, unused: 1, undocumented: 2, atRisk: 0 });
  });

  it("finds a data product's boundary", () => {
    const { inputs, consumers } = boundary(c, bundle.dataProducts![0]);
    expect(inputs.map((e) => e.name)).toEqual(["web01"]);
    expect(consumers.map((e) => e.name)).toEqual(["board"]);
  });
});

describe("reach", () => {
  it("reports hops and the path for impact analysis", () => {
    const down = reach(c, host.id, "down").map((r) => [r.entity.name, r.depth, r.via?.name]);
    expect(down).toEqual([["web", 1, undefined], ["rollup", 2, "web"], ["summary", 3, "rollup"], ["board", 4, "summary"]]);
    expect(reach(c, host.id, "down", 2)).toHaveLength(2);
    expect(reach(c, board.id, "up").map((r) => r.entity.name)).toEqual(["summary", "rollup", "web", "web01"]);
  });
});
