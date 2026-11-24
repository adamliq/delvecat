import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { Catalog } from "./catalog";
import { filterFindings } from "./findings";
import { filterItems, items } from "./healthView";
import { coverageBy } from "./insights";
import { catalogTables } from "./sql";
import { importAgeDays } from "./transfer";

const e = (id: string, instance: string, extra: Partial<Entity> = {}): Entity =>
  ({ id, type: "savedSearch", name: id, instance, product: "splunk", app: "acme",
    health: { status: "warning", checks: [{ check: "skipped", status: "warning", message: "m" }] }, ...extra }) as Entity;

const bundle = {
  schemaVersion: "0.1.0", generatedAt: "2026-11-24T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [
    { id: "adhoc", name: "Ad hoc", kind: "splunkCloud" },
    { id: "es", name: "ES", kind: "splunkCloud", webUrl: "https://es.example.com", imported: { from: "stack es:8089", at: "2026-11-20T00:00:00Z", by: "alice" } },
  ],
  entities: [e("a1", "adhoc"), e("a2", "adhoc"), e("s1", "es")],
  edges: [],
} as unknown as CatalogBundle;

describe("several stacks in one catalog", () => {
  it("filters findings by stack", () => {
    const all = items(bundle.entities, bundle, new Map());
    expect(filterItems(all, { instance: "es" }).map((x) => x.entity.id)).toEqual(["s1"]);
    expect(filterFindings(all, { instance: "adhoc" })).toHaveLength(2);
  });

  it("groups documentation coverage by stack", () => {
    const { groups } = coverageBy(new Catalog(bundle), "instance", true);
    expect(groups.map((g) => [g.group, g.total]).sort()).toEqual([["adhoc", 2], ["es", 1]]);
  });

  it("lists each stack's address and import in SQL", async () => {
    const tables = catalogTables(bundle);
    const inst = tables.find((t) => t.name === "instances")!;
    const cols = inst.columns.map((c) => c.name);
    const es = inst.rows.find((r) => r[0] === "es")!;
    expect(es[cols.indexOf("web_url")]).toBe("https://es.example.com");
    expect(es[cols.indexOf("imported_from")]).toBe("stack es:8089");
    expect(es[cols.indexOf("imported_by")]).toBe("alice");
    expect(inst.rows.find((r) => r[0] === "adhoc")![cols.indexOf("imported_from")]).toBeNull();
  });

  it("ages imports in days", () => {
    expect(importAgeDays("2026-11-20T00:00:00Z", Date.parse("2026-11-24T12:00:00Z"))).toBe(4);
    expect(importAgeDays(undefined)).toBeUndefined();
  });
});
