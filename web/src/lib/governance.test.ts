import { describe, expect, it } from "vitest";
import type { Entity } from "../generated/catalog";
import { isSensitive, matchesClass } from "./governance";
import { EntitySearch } from "./search";

const e = (id: string, classifications: { name: string; sensitive: boolean; derived: boolean }[]): Entity => ({
  id, type: "index", name: id, product: "splunk", instance: "i", governance: { classifications },
});

describe("governance helpers", () => {
  it("matches classification hierarchies", () => {
    expect(matchesClass("PII.IPAddress", "PII")).toBe(true);
    expect(matchesClass("PII", "PII")).toBe(true);
    expect(matchesClass("PIIX", "PII")).toBe(false);
    expect(matchesClass("anything", "")).toBe(true);
  });
  it("tells sensitive from derived and public data", () => {
    const direct = e("a", [{ name: "PII.Email", sensitive: true, derived: false }]);
    const derived = e("b", [{ name: "PII.Email", sensitive: true, derived: true }]);
    const pub = e("c", [{ name: "Public", sensitive: false, derived: false }]);
    expect([isSensitive(direct), isSensitive(derived), isSensitive(pub)]).toEqual([true, true, false]);
    const facets = new EntitySearch([direct, derived, pub]).query("").facets.sensitivity;
    expect(Object.fromEntries(facets)).toEqual({ sensitive: 1, "sensitive (derived)": 1 });
  });
});
