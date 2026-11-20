import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { placeLabels } from "../components/SchemaNetwork";
import { Catalog } from "./catalog";
import { howToFix } from "./coverageAdvice";
import type { DetectionStatus } from "./coverage";
import { measuredAt } from "./health";
import { isIsoDate, numberWithUnit, parseDate, propLabel, relative, valueLabel } from "./propertyFormat";
import { EntitySearch, highlightParts, matchSnippet } from "./search";
import { macroName, splTokens } from "./splHighlight";

const ent = (o: Partial<Entity> & { id: string; type: string; name: string }): Entity => ({ instance: "acme", product: "splunk", ...o }) as Entity;

describe("ages count from when the catalog was measured", () => {
  it("uses the health report's time, else when the bundle was generated", () => {
    const bundle = { generatedAt: "2026-11-20T09:00:00Z", ingestionReport: [{ connector: "health", status: "ok", message: "as of 2026-11-06T07:34:34Z" }] } as CatalogBundle;
    expect(new Date(measuredAt(bundle)).toISOString()).toBe("2026-11-06T07:34:34.000Z");
    expect(new Date(measuredAt({ generatedAt: "2026-11-20T09:00:00Z" } as CatalogBundle)).toISOString()).toBe("2026-11-20T09:00:00.000Z");
    expect(relative("2026-11-06T01:34:34Z", measuredAt(bundle))).toBe("6 hours ago");
  });

  it("reads Splunk's UTC times and labels sizes", () => {
    expect(isIsoDate("2026-11-06 07:45:00 UTC")).toBe(true);
    expect(new Date(parseDate("2026-11-06 07:45:00 UTC")).toISOString()).toBe("2026-11-06T07:45:00.000Z");
    expect(propLabel("currentDBSizeMB")).toBe("Current size");
    expect(numberWithUnit("currentDBSizeMB", 19200)).toBe("18.8 GB");
    expect(numberWithUnit("licenseMBPerDay", 0.005)).toBe("5 KB a day");
    expect(valueLabel("alertSeverity", "4")).toBe("4 (medium)");
  });
});

describe("search says why a result matched", () => {
  const entities = [
    ent({ id: "acme:index:fw", type: "index", name: "fw", description: "Firewall logs" }),
    ent({ id: "acme:outputGroup:tcpout:x", type: "outputGroup", name: "tcpout:x", properties: { servers: ["10.9.0.1:9997"] } }),
    ent({ id: "acme:savedSearch:a/s", type: "savedSearch", name: "s", properties: { search: "index=fw | stats count by zebra_field" } }),
  ];
  const search = new EntitySearch(entities);

  it("returns the fields and words that matched", () => {
    const { matches } = search.query("firewall");
    expect(matches.get("acme:index:fw")?.fields).toContain("description");
  });

  it("shows the value or the SPL around the match", () => {
    const r = search.query("10.9.0.1");
    const out = entities[1];
    expect(matchSnippet(out, r.matches.get(out.id))).toMatchObject({ key: "servers", text: "10.9.0.1:9997" });
    const z = search.query("zebra");
    expect(matchSnippet(entities[2], z.matches.get(entities[2].id))?.text).toContain("zebra_field");
  });

  it("highlights matched words, longest first, case-insensitively", () => {
    expect(highlightParts("Firewall logs", ["fire"])).toEqual([["Fire", true], ["wall logs", false]]);
    expect(highlightParts("abc", [])).toEqual([["abc", false]]);
  });
});

describe("SPL highlighting", () => {
  it("names macros as Splunk stores them", () => {
    expect(macroName("rare_port_threshold(5)")).toBe("rare_port_threshold(1)");
    expect(macroName("histperc(a, 5, \"x,y\")")).toBe("histperc(3)");
    expect(macroName("secops_only_filter")).toBe("secops_only_filter");
  });

  it("marks commands and finds the objects a search names", () => {
    const t = splTokens('index=firewall sourcetype="acme:fw" | lookup asset_owners ip | `rare_port_threshold(5)` | stats count by host');
    const refs = t.filter((x) => x.ref).map((x) => `${x.ref!.type}:${x.ref!.name}`);
    expect(refs).toEqual(["index:firewall", "sourcetype:acme:fw", "lookup:asset_owners", "macro:rare_port_threshold(1)"]);
    expect(t.filter((x) => x.kind === "command").map((x) => x.text)).toEqual(["|", "lookup", "|", "|", "stats"]);
    expect(t.find((x) => x.text === "by")?.kind).toBe("keyword");
    expect(t.map((x) => x.text).join("")).toBe('index=firewall sourcetype="acme:fw" | lookup asset_owners ip | `rare_port_threshold(5)` | stats count by host');
  });

  it("does not link wildcards", () => {
    expect(splTokens("index=web*").some((x) => x.ref)).toBe(false);
  });
});

describe("what would let a detection fire", () => {
  const catalog = new Catalog({
    schemaVersion: "0.1.0", generatedAt: "2026-11-20T00:00:00Z", generator: { name: "t", version: "0" }, instances: [],
    entities: [
      ent({ id: "acme:tag:authentication", type: "tag", name: "authentication" }),
      ent({ id: "acme:sourcetype:linux_secure", type: "sourcetype", name: "linux_secure" }),
    ],
    edges: [{ from: "acme:tag:authentication", to: "acme:sourcetype:linux_secure", type: "appliesTo" }],
  } as unknown as CatalogBundle);
  const det = (state: DetectionStatus["state"], extra: Partial<Entity> = {}, dataModels: string[] = []): DetectionStatus =>
    ({ entity: ent({ id: "acme:correlationSearch:x", type: "correlationSearch", name: "x", app: "SA", ...extra }), state, techniques: [], dataModels });

  it("explains each reason", () => {
    expect(howToFix(catalog, det("disabled"))[0]).toMatch(/Enable it in Splunk \(app SA\)/);
    expect(howToFix(catalog, det("broken", { lineage: { unresolved: ["dataModel:Endpoint"] } } as Partial<Entity>))[0]).toMatch(/Install the data model Endpoint.*Splunk_SA_CIM.*process/);
    const noData = howToFix(catalog, det("noData", {}, ["Authentication"]))[0];
    expect(noData).toMatch(/events tagged authentication/);
    expect(noData).toMatch(/linux_secure/);
  });
});

describe("graph labels", () => {
  it("does not stack two labels on the same spot", () => {
    const nodes = [
      { x: 100, y: 100, r: 8, kind: "st", label: "access_combined" },
      { x: 150, y: 100, r: 6, kind: "st", label: "scheduler" },
      { x: 100, y: 112, r: 6, kind: "st", label: "WinEventLog:Security" },
    ] as Parameters<typeof placeLabels>[0];
    placeLabels(nodes);
    const spots = nodes.map((n) => `${(n.x ?? 0) + n.labelAt!.dx},${(n.y ?? 0) + n.labelAt!.dy}`);
    expect(new Set(spots).size).toBe(3);
    expect(nodes[0].labelAt).not.toEqual({ dx: 12, dy: 4, anchor: "start" }); // the right side is taken by "scheduler"
  });
});
