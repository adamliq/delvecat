import { describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { scopedBundle } from "./CatalogContext";
import { ago, ALL_PAGES, menuOf, MENUS } from "./nav";

describe("menu bar", () => {
  it("puts every page in a menu and highlights the menu of pages without their own entry", () => {
    expect(MENUS.flatMap((m) => m.items.map((i) => i.to))).toEqual(expect.arrayContaining(["/search", "/changes", "/compare", "/findings", "/sql"]));
    expect(menuOf("/entity/acme%3Aindex%3Aweb")).toBe("explore");
    expect(menuOf("/compare")).toBe("explore");
    expect(menuOf("/commands/stats")).toBe("analyse");
    expect(menuOf("/glossary/Storefront")).toBe("explore");
    expect(menuOf("/health")).toBe("quality");
    expect(menuOf("/build")).toBe("admin");
    expect(menuOf("/")).toBeUndefined();
    expect(ALL_PAGES.map((p) => p.label)).toContain("Help");
  });

  it("says how long ago a build was", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(ago("2026-11-24T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-11-24T11:20:00Z", now)).toBe("40 min ago");
    expect(ago("2026-11-24T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-20T12:00:00Z", now)).toBe("4 days ago");
  });

  it("limits a catalog to one stack", () => {
    const b = {
      schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
      instances: [{ id: "a", name: "A", kind: "splunkEnterprise" }, { id: "b", name: "B", kind: "splunkEnterprise" }],
      entities: [
        { id: "a:index:x", type: "index", name: "x", product: "splunk", instance: "a" },
        { id: "a:sourcetype:y", type: "sourcetype", name: "y", product: "splunk", instance: "a" },
        { id: "b:index:x", type: "index", name: "x", product: "splunk", instance: "b" },
      ],
      edges: [{ from: "a:sourcetype:y", to: "a:index:x", type: "feeds" }, { from: "a:sourcetype:y", to: "b:index:x", type: "feeds" }],
    } as CatalogBundle;
    const s = scopedBundle(b, "a");
    expect(s.instances.map((i) => i.id)).toEqual(["a"]);
    expect(s.entities.map((e) => e.id)).toEqual(["a:index:x", "a:sourcetype:y"]);
    expect(s.edges).toHaveLength(1);
  });
});
