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

describe("user reach", () => {
  it("is the union of the user's roles, with the roles it comes through", async () => {
    const { Catalog } = await import("./catalog");
    const { sensitiveAccess } = await import("./governance");
    const role = (name: string, ids: string[]) => ({
      id: `i:role:${name}`, type: "role" as const, name, product: "splunk" as const, instance: "i",
      governance: { sensitiveAccess: ids.map((id) => ({ id, classifications: ["PII"], how: "search", filtered: false })) },
    });
    const u = { id: "i:user:ada", type: "user" as const, name: "ada", product: "splunk" as const, instance: "i" };
    const c = new Catalog({
      schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
      instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
      entities: [role("a", ["i:index:x", "i:index:y"]), role("b", ["i:index:y"]), u],
      edges: [{ from: u.id, to: "i:role:a", type: "memberOf" }, { from: u.id, to: "i:role:b", type: "memberOf" }],
    });
    expect(sensitiveAccess(u, c).map((a) => [a.id, a.viaRoles])).toEqual([
      ["i:index:x", ["i:role:a"]],
      ["i:index:y", ["i:role:a", "i:role:b"]],
    ]);
    expect(sensitiveAccess(u)).toEqual([]); // without the catalog only stored data is read
  });
});
