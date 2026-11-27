import { describe, expect, it } from "vitest";
import type { Entity, EntityType } from "../generated/catalog";
import { EntitySearch, FACETS, propertyValues } from "./search";

const ent = (type: EntityType, name: string, properties: Record<string, unknown> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", properties });

describe("search by values", () => {
  const acct = ent("addOnAccount", "prod_app", { tenantId: "0f1e2d3c-aaaa-bbbb-cccc-111122223333", cloudEnvironment: "Azure Public Cloud" });
  const out = ent("outputGroup", "tcpout:siem", { servers: ["siem1.acme.example:9997"] });
  const idx = ent("index", "web", { storage: { tiers: [{ tier: "warm", bucket: "acme-smartstore", provider: "Amazon S3" }] } });
  const search = new EntitySearch([acct, out, idx]);

  it("finds an object by a value it holds", () => {
    expect(search.search("0f1e2d3c-aaaa-bbbb-cccc-111122223333").map((e) => e.name)).toEqual(["prod_app"]);
    expect(search.search("siem1.acme.example").map((e) => e.name)).toEqual(["tcpout:siem"]);
    expect(search.search("acme-smartstore").map((e) => e.name)).toEqual(["web"]);
  });

  it("collects short text values, not dates or long text", () => {
    const values = propertyValues({ a: "x1", b: "2026-11-19T20:50:17Z", c: "y".repeat(300), d: ["z1", { e: "w1" }], search: "index=web" });
    expect(values).toEqual(["x1", "z1", "w1"]);
  });

  it("ranks an exact value first, even one word search splits", () => {
    const macro = ent("macro", "rangemap", { definition: "rangemap field=x low=0-9 elevated=10-1" });
    const out2 = ent("outputGroup", "tcpout:siem2", { servers: ["10.9.0.1:9997"] });
    const s2 = new EntitySearch([macro, out2]);
    expect(s2.search("10.9.0.1")[0].name).toBe("tcpout:siem2");
    expect(s2.search("10.9.0.1:9997")[0].name).toBe("tcpout:siem2");
  });
});

describe("input type and Microsoft facets", () => {
  const inp = (name: string, kind: string, ms?: { addOn: string; service: string }) =>
    ({ id: `i:input:${name}`, type: "input", name, product: "splunk", instance: "i",
       properties: { kind, ...(ms ? { microsoft: ms } : {}) } }) as unknown as Entity;
  const ents = [
    inp("mscs_azure_event_hub://eh", "mscs_azure_event_hub", { addOn: "Splunk Add-on for Microsoft Cloud Services", service: "Event Hubs" }),
    inp("MS_AAD_signins://s", "MS_AAD_signins", { addOn: "Splunk Add-on for Microsoft Azure", service: "Entra ID sign-ins" }),
    inp("monitor:///var/log", "monitor"),
  ];
  const s = new EntitySearch(ents, { inputType: FACETS.inputType, microsoftService: FACETS.microsoftService, microsoftAddOn: FACETS.microsoftAddOn });
  it("filters by input type, Microsoft service and add-on", () => {
    expect(s.query("", { inputType: ["monitor"] }).results.map((e) => e.name)).toEqual(["monitor:///var/log"]);
    expect(s.query("", { microsoftService: ["Event Hubs"] }).results.map((e) => e.name)).toEqual(["mscs_azure_event_hub://eh"]);
    expect(s.query("", { microsoftAddOn: ["Splunk Add-on for Microsoft Azure"] }).results.map((e) => e.name)).toEqual(["MS_AAD_signins://s"]);
  });
});

describe("word index built after the page appears", () => {
  const many = Array.from({ length: 7000 }, (_, i) => ent("savedSearch", `search_${i}`, { search: `index=web_${i % 7}` }));
  it("is not built up front; a text search completes it, so results are never partial", () => {
    const s = new EntitySearch(many);
    expect(s.ready).toBe(false);
    expect(s.query("").results.length).toBe(7000); // filters and Browse need no index
    expect(s.query("search_6999").results[0].name).toBe("search_6999");
    expect(s.ready).toBe(true);
  });
  it("builds in steps in the background", async () => {
    const s = new EntitySearch(many);
    const done = s.indexInBackground();
    expect(s.ready).toBe(false);
    await done;
    expect(s.ready).toBe(true);
    expect(s.query("search_3").results.some((e) => e.name === "search_3")).toBe(true);
  });
});

describe("searching while the word index is still being built", () => {
  it("answers at once from names and descriptions, marked partial, then fully", async () => {
    const many = Array.from({ length: 9000 }, (_, i) => ent("savedSearch", `search_${i}`, { search: `index=web_${i % 7}` }));
    const s = new EntitySearch(many);
    const done = s.indexInBackground();
    const quick = s.query("search_8999");
    expect(quick.partial).toBe(true);
    expect(quick.results.map((e) => e.name)).toContain("search_8999");
    expect(s.query("web_3").results.length).toBe(0); // SPL text needs the full index
    await done;
    const full = s.query("web_3");
    expect(full.partial).toBeUndefined();
    expect(full.results.length).toBeGreaterThan(0);
  });
});
