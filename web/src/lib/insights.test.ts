import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { coverageBy, isVendor, mostUsed, usagePercentile, usageScore } from "./insights";
import { badges } from "./overlays";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const vendorApp = ent("app", "Splunk_SA_CIM", { properties: { author: "Splunk" } });
const idx = (n: string, searches: number, extra: Partial<Entity> = {}) => ent("index", n, { usage: { adhocSearches: searches }, ...extra });
const entities: Entity[] = [
  vendorApp,
  ent("savedSearch", "documented", { app: "acme", description: "x", annotations: { owners: ["soc"], domain: "Security" }, usage: { runs: 4 } }),
  ent("savedSearch", "bare", { app: "acme", usage: { runs: 0 } }),
  ent("dataModel", "cim", { app: "Splunk_SA_CIM" }),
  ent("field", "st/x"), // not a documented type
  idx("a", 10, { annotations: { missingProperties: ["tier"] } }), idx("b", 5), idx("c", 1), idx("d", 0), idx("e", 0),
];
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }], entities, edges: [],
  structuredProperties: [{ id: "tier", type: "string", appliesTo: ["index"], required: true }],
};
const c = new Catalog(bundle);
const byName = (n: string) => entities.find((e) => e.name === n)!;

describe("insights", () => {
  it("measures coverage per group, leaving out vendor apps unless asked", () => {
    expect(isVendor(c, byName("cim"))).toBe(true);
    const { overall, groups } = coverageBy(c, "app", false);
    expect(overall.total).toBe(7);
    expect(overall.counts.described).toEqual([1, 7]);
    expect(overall.counts.owned).toEqual([1, 7]);
    expect(overall.counts.complete).toEqual([4, 5]); // only indexes need the required property
    expect(groups.map((g) => [g.group, g.total])).toEqual([["(no app)", 5], ["acme", 2]]);
    expect(coverageBy(c, "app", true).overall.total).toBe(8);
    expect(coverageBy(c, "domain", false).groups.map((g) => g.group)).toEqual(["(no domain)", "Security"]);
  });

  it("ranks usage and gives percentiles within a type", () => {
    expect(usageScore(byName("documented"))).toBe(4);
    expect(usageScore(byName("cim"))).toBeUndefined();
    expect(mostUsed(c, ["index"]).map((x) => [x.entity.name, x.score])).toEqual([["a", 10], ["b", 5], ["c", 1]]);
    expect(usagePercentile(c, byName("a"))).toBe(80);
    expect(usagePercentile(c, byName("d"))).toBe(0);
    expect(usagePercentile(c, byName("documented"))).toBeUndefined(); // fewer than five to compare
  });

  it("badges health, risk and sensitivity with text, not just color", () => {
    const sick = ent("index", "sick", {
      health: { status: "critical", checks: [{ check: "fresh", status: "critical", message: "no data for 3 days" }] },
      governance: { classifications: [{ name: "PII.Email", sensitive: true, how: "annotated", derived: false, columns: ["email"] }] },
    });
    const cat = new Catalog({ ...bundle, entities: [sick], edges: [] });
    expect(badges(cat, sick).map((b) => [b.kind, b.text])).toEqual([["critical", "✕"], ["sensitive", "PII"]]);
    expect(badges(cat, sick)[1].title).toBe("Sensitive: PII.Email in email");
  });
});
