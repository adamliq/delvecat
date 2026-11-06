import { describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { BundleError, Catalog, defaultBundleUrl, parseBundle } from "./catalog";
import { pluralTypeLabel, typeLabel } from "./labels";
import { EntitySearch } from "./search";

const bundle: CatalogBundle = {
  schemaVersion: "0.1.0",
  generatedAt: "2026-11-01T00:00:00Z",
  generator: { name: "test", version: "0" },
  instances: [{ id: "acme", name: "acme", kind: "splunkEnterprise" }],
  entities: [
    { id: "acme:app:acme_web", type: "app", name: "acme_web", product: "splunk", instance: "acme" },
    { id: "acme:index:web", type: "index", name: "web", product: "splunk", instance: "acme", app: "acme_web" },
    {
      id: "acme:savedSearch:acme_web/nobody/Web - Top Error Pages",
      type: "savedSearch",
      name: "Web - Top Error Pages",
      product: "splunk",
      instance: "acme",
      app: "acme_web",
      properties: { search: "index=summary_web | stats sum(count) by uri_path" },
    },
    {
      id: "acme:macro:acme_secops/nobody/rare_port_threshold(1)",
      type: "macro",
      name: "rare_port_threshold(1)",
      product: "splunk",
      instance: "acme",
      app: "acme_secops",
      description: "Threshold for rare destination ports",
    },
  ],
  edges: [{ from: "acme:app:acme_web", to: "acme:index:web", type: "contains" }],
};

describe("parseBundle", () => {
  it("accepts a valid bundle", () => {
    expect(parseBundle(JSON.stringify(bundle)).entities).toHaveLength(4);
  });
  it.each([
    ["not json", "{"],
    ["missing version", "{}"],
    ["future version", JSON.stringify({ ...bundle, schemaVersion: "2.0.0" })],
    ["missing arrays", JSON.stringify({ schemaVersion: "0.1.0" })],
  ])("rejects %s", (_, text) => {
    expect(() => parseBundle(text)).toThrow(BundleError);
  });
});

describe("Catalog", () => {
  const c = new Catalog(bundle);
  it("indexes edges both ways", () => {
    expect(c.edgesFrom("acme:app:acme_web")).toHaveLength(1);
    expect(c.edgesTo("acme:index:web")[0].from).toBe("acme:app:acme_web");
    expect(c.edgesTo("nope")).toEqual([]);
  });
  it("counts by type", () => {
    expect(c.countBy("type").get("index")).toBe(1);
  });
});

describe("EntitySearch", () => {
  const s = new EntitySearch(bundle.entities);
  it("finds by name tokens", () => {
    expect(s.search("error pages").map((e) => e.name)).toEqual(["Web - Top Error Pages"]);
  });
  it("finds by SPL body split on Splunk separators", () => {
    expect(s.search("summary_web").map((e) => e.type)).toContain("savedSearch");
    expect(s.search("uri_path")[0].type).toBe("savedSearch");
  });
  it("finds by prefix and description", () => {
    expect(s.search("thresh")[0].type).toBe("macro");
    expect(s.search("destination")[0].type).toBe("macro");
  });
  it("applies filters, and lists everything for an empty query", () => {
    expect(s.search("", { app: "acme_web" })).toHaveLength(2);
    expect(s.search("", { type: "index" }).map((e) => e.name)).toEqual(["web"]);
    expect(s.search("")).toHaveLength(4);
  });
});

describe("helpers", () => {
  it("labels types", () => {
    expect(typeLabel("savedSearch")).toBe("Saved Search");
    expect(typeLabel("soarPlaybook")).toBe("SOAR Playbook");
    expect(pluralTypeLabel("index")).toBe("Indexes");
    expect(pluralTypeLabel("correlationSearch")).toBe("Detections");
    expect(pluralTypeLabel("macro")).toBe("Macros");
    expect(pluralTypeLabel("savedSearch")).toBe("Saved Searches");
    expect(pluralTypeLabel("dashboard")).toBe("Dashboards");
  });
  it("lets ?bundle= override the bundle url", () => {
    expect(defaultBundleUrl({ search: "?bundle=https://x/y.json" })).toBe("https://x/y.json");
    expect(defaultBundleUrl({ search: "" })).toMatch(/catalog\.json$/);
  });
});
