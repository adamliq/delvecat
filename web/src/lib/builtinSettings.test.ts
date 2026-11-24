import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { EntitySearch, FACETS, isBuiltinSetting } from "./search";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const builtinRange = ent("timeRange", "last_24_hours", { properties: { builtin: true } });
const ownRange = ent("timeRange", "business_hours", { app: "acme" });
const search = ent("savedSearch", "s", { lineage: { commands: ["stats"] } });
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [builtinRange, ownRange, search], edges: [],
};

describe("built-in settings and catalog indexes", () => {
  it("leaves built-in settings out of results and counts when asked", () => {
    expect([builtinRange, ownRange, search].map(isBuiltinSetting)).toEqual([true, false, false]);
    const s = new EntitySearch(bundle.entities, FACETS);
    const shown = s.query("", {}, "name", isBuiltinSetting);
    expect(shown.results.map((e) => e.name)).toEqual(["business_hours", "s"]);
    expect(shown.facets.type.get("timeRange")).toBe(1);
    expect(s.query("", {}, "name").results).toHaveLength(3);
  });

  it("finds objects by stack, type and name, and by type", () => {
    const c = new Catalog(bundle);
    expect(c.findOne("i", "timeRange", "business_hours")).toBe(ownRange);
    expect(c.findOne("j", "timeRange", "business_hours")).toBeUndefined();
    expect(c.ofType("timeRange")).toEqual([builtinRange, ownRange]);
    expect(c.ofType("index")).toEqual([]);
  });
});
