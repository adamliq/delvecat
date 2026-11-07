import { describe, expect, it } from "vitest";
import type { Entity, EntityType } from "../generated/catalog";
import { annotationSnippet } from "./annotate";
import { EntitySearch } from "./search";
import { coverage, formatValue, propertyFacets, summaryChips, valueStrings, type PropertyDef } from "./structured";

const ent = (type: EntityType, name: string, annotations: Entity["annotations"] = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", annotations });

const tier: PropertyDef = {
  id: "retentionTier", displayName: "Retention tier", type: "string", appliesTo: ["index"], required: true,
  allowedValues: [{ value: "hot", description: "fast disk" }, "cold"], showInFilters: true, showInSummary: true,
};
const scope: PropertyDef = { id: "scope", type: "string", cardinality: "multiple", showInFilters: true };
const reviewed: PropertyDef = { id: "reviewed", type: "date" };
const paged: PropertyDef = { id: "paged", type: "boolean", showInFilters: true };

const web = ent("index", "web", { properties: { retentionTier: "hot", scope: ["PCI-DSS", "SOX"], paged: true } });
const os = ent("index", "os", { missingProperties: ["retentionTier"] });
const search = ent("savedSearch", "s", { properties: { scope: "SOX", paged: false } });

describe("structured properties", () => {
  it("formats values for display and filtering", () => {
    expect(valueStrings(true)).toEqual(["Yes"]);
    expect(valueStrings(["a", 2])).toEqual(["a", "2"]);
    expect(formatValue(paged, false)).toBe("No");
    expect(formatValue(reviewed, "2026-03-01")).toBe(new Date("2026-03-01T00:00:00").toLocaleDateString());
    expect(formatValue(reviewed, "not a date")).toBe("not a date");
  });

  it("measures coverage against applicable types", () => {
    expect(coverage([web, os, search], tier)).toEqual({ applicable: 2, filled: 1, missing: 1 });
    expect(coverage([web, os, search], scope)).toEqual({ applicable: 3, filled: 2, missing: 0 });
  });

  it("adds a search facet per filterable property", () => {
    const facets = propertyFacets([tier, scope, reviewed, paged]);
    expect(Object.keys(facets)).toEqual(["p.retentionTier", "p.scope", "p.paged"]);
    const s = new EntitySearch([web, os, search], facets);
    expect(s.facetNames).toContain("p.scope");
    expect(s.facetNames).toContain("missing");
    expect(s.query("", { "p.scope": ["SOX"] }).results.map((e) => e.name).sort()).toEqual(["s", "web"]);
    expect(s.query("", { "p.paged": ["No"] }).results.map((e) => e.name)).toEqual(["s"]);
    expect(s.query("", { missing: ["retentionTier"] }).results.map((e) => e.name)).toEqual(["os"]);
  });

  it("builds summary chips and snippet placeholders", () => {
    expect(summaryChips([tier, scope], web)).toEqual([{ id: "retentionTier", text: "Retention tier: hot" }]);
    expect(annotationSnippet(os)).toContain('    properties: {"retentionTier": ""}');
    expect(annotationSnippet(web)).toContain('"scope": ["PCI-DSS", "SOX"]');
  });
});
