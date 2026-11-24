import { describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { Catalog } from "./catalog";
import { buildChanges, objectHistory } from "./changes";

const bundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-11-03T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }], entities: [], edges: [],
  changes: { previousGeneratedAt: "2026-11-02T00:00:00Z", added: [], removed: [], modified: ["x"],
    details: { x: [{ key: "properties.search", before: "a", after: "b" }] } },
  changeHistory: [
    { generatedAt: "2026-11-02T00:00:00Z", previousGeneratedAt: "2026-11-01T00:00:00Z", added: [], removed: [], modified: ["y"] },
    { generatedAt: "2026-11-01T00:00:00Z", previousGeneratedAt: "2026-10-31T00:00:00Z", added: ["x"], removed: [], modified: [] },
  ],
} as unknown as CatalogBundle;

describe("change history", () => {
  const c = new Catalog(bundle);
  it("lists this build's changes then the earlier ones, newest first", () => {
    expect(buildChanges(c).map((b) => b.generatedAt)).toEqual(["2026-11-03T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"]);
  });
  it("gives an object's history with what changed", () => {
    expect(objectHistory(c, "x")).toEqual([
      { generatedAt: "2026-11-03T00:00:00Z", kind: "modified", rows: [{ key: "properties.search", before: "a", after: "b" }] },
      { generatedAt: "2026-11-01T00:00:00Z", kind: "added", rows: [] },
    ]);
    expect(objectHistory(c, "z")).toEqual([]);
  });
});
