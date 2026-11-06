import { describe, expect, it } from "vitest";
import type { Entity } from "../generated/catalog";
import { annotationSnippet, editLinks, effectiveDescription, parseSource, suggestedFileName } from "./annotate";
import { EntitySearch } from "./search";
import { searchPath } from "./routes";

const e = (over: Partial<Entity>): Entity => ({
  id: "i:index:x", type: "index", name: "x", product: "splunk", instance: "i", ...over,
});

const entities: Entity[] = [
  e({ id: "i:index:web", name: "web", app: "acme_web",
      annotations: { owners: ["web-team"], classifications: ["PII.IPAddress"], description: "Storefront logs" } }),
  e({ id: "i:index:fw", name: "firewall", app: "ta_fw",
      annotations: { owners: ["soc", "netops"], classifications: ["PII.IPAddress"] } }),
  e({ id: "i:macro:acme_web/m", type: "macro", name: "status_buckets", app: "acme_web", disabled: true }),
  e({ id: "i:savedSearch:acme_web/s", type: "savedSearch", name: "Top pages", app: "acme_web",
      description: "From Splunk", annotations: { owners: ["web-team"], tags: ["exec"] } }),
];

describe("faceted search", () => {
  const s = new EntitySearch(entities);

  it("counts each facet with the other facets applied", () => {
    const { results, facets } = s.query("", { owner: ["web-team"] });
    expect(results.map((r) => r.name).sort()).toEqual(["Top pages", "web"]);
    // owner facet ignores its own filter, so every owner stays selectable
    expect(Object.fromEntries(facets.owner)).toEqual({ "web-team": 2, soc: 1, netops: 1 });
    // type facet respects the owner filter
    expect(Object.fromEntries(facets.type)).toEqual({ index: 1, savedSearch: 1 });
  });

  it("ORs values within a facet and ANDs across facets", () => {
    expect(s.query("", { owner: ["soc", "web-team"] }).results).toHaveLength(3);
    expect(s.query("", { owner: ["soc", "web-team"], type: ["savedSearch"] }).results.map((r) => r.name))
      .toEqual(["Top pages"]);
  });

  it("supports status and documentation facets", () => {
    expect(s.query("", { status: ["disabled"] }).results.map((r) => r.name)).toEqual(["status_buckets"]);
    expect(s.query("", { documented: ["no"] }).results.map((r) => r.name).sort()).toEqual(["firewall", "status_buckets"]);
  });

  it("searches annotation text", () => {
    expect(s.query("storefront").results.map((r) => r.name)).toEqual(["web"]);
    expect(s.query("netops").results.map((r) => r.name)).toEqual(["firewall"]);
    expect(s.query("exec").results.map((r) => r.name)).toEqual(["Top pages"]);
  });

  it("sorts", () => {
    expect(s.query("", {}, "type").results.map((r) => r.type)).toEqual(["index", "index", "macro", "savedSearch"]);
  });
});

describe("annotation helpers", () => {
  it("prefers the annotated description", () => {
    expect(effectiveDescription(entities[3])).toBe("From Splunk");
    expect(effectiveDescription(entities[0])).toBe("Storefront logs");
    expect(effectiveDescription(entities[2])).toBeUndefined();
  });

  it("builds a YAML snippet that quotes ids", () => {
    const yaml = annotationSnippet(e({ id: 'i:savedSearch:a/Web: "x"', name: "n" }));
    expect(yaml).toContain('  - id: "i:savedSearch:a/Web: \\"x\\""');
    expect(yaml).toContain('    owners: []');
  });

  it("builds GitHub edit and new-file links", () => {
    const src = { repoUrl: "https://github.com/o/r/", branch: "main", path: "annotations" };
    const withSource = { ...entities[0], annotations: { ...entities[0].annotations, sources: ["annotations/acme/web.yaml:12"], primarySource: "annotations/acme/web.yaml:12" } };
    const links = editLinks(withSource, src);
    expect(links.sources[0]).toEqual({
      label: "annotations/acme/web.yaml:12",
      view: "https://github.com/o/r/blob/main/annotations/acme/web.yaml#L12",
      edit: "https://github.com/o/r/edit/main/annotations/acme/web.yaml",
    });
    expect(links.primary?.edit).toBe("https://github.com/o/r/edit/main/annotations/acme/web.yaml");
    expect(editLinks(entities[1], src).primary).toBeUndefined();
    const url = new URL(links.create);
    expect(url.pathname).toBe("/o/r/new/main");
    expect(url.searchParams.get("filename")).toMatch(/^annotations\/i\/index-web-[0-9a-f]{6}\.yaml$/);
    expect(url.searchParams.get("value")).toContain('id: "i:index:web"');
  });

  it("makes stable, distinct file names", () => {
    const a = suggestedFileName(e({ id: "i:index:a/x", name: "Web - Top Pages!" }));
    expect(a).toMatch(/^i\/index-web-top-pages-[0-9a-f]{6}\.yaml$/);
    expect(a).toBe(suggestedFileName(e({ id: "i:index:a/x", name: "Web - Top Pages!" })));
    expect(a).not.toBe(suggestedFileName(e({ id: "i:index:b/x", name: "Web - Top Pages!" })));
  });

  it("parses sources and builds multi-value search paths", () => {
    expect(parseSource("annotations/a.yaml:3")).toEqual({ file: "annotations/a.yaml", line: 3 });
    expect(parseSource("annotations/a.yaml")).toEqual({ file: "annotations/a.yaml", line: undefined });
    expect(searchPath({ type: ["index", "macro"], q: "" })).toBe("/search?type=index&type=macro");
  });
});
