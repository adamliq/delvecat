import { describe, expect, it } from "vitest";
import type { Entity, EntityType } from "../generated/catalog";
import { byName, EntitySearch, FACETS, isBuiltinSetting, propertyValues } from "./search";
import { demoBundle } from "./demoCatalog.testutil";

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

describe("facet counts", () => {
  it("match the straightforward definition for any combination of filters", () => {
    const types = ["savedSearch", "dashboard", "index", "macro"] as const;
    const apps = ["a", "b", "c"];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const ents = Array.from({ length: 400 }, (_, i) => ({
      ...ent(types[rnd(4)], `o${i}`, {}),
      app: apps[rnd(3)],
      disabled: rnd(5) === 0,
      annotations: rnd(3) ? { tags: [["x"], ["y"], ["x", "y"], []][rnd(4)] } : undefined,
    })) as Entity[];
    const s = new EntitySearch(ents);
    const reference = (filters: Record<string, string[]>) => {
      const active = s.facetNames.filter((f) => filters[f]?.length);
      const passes = (e: Entity, skip?: string) => active.every((f) => f === skip || s.facets[f](e).some((v) => filters[f]!.includes(v)));
      const out: Record<string, Record<string, number>> = {};
      for (const f of s.facetNames) {
        const c: Record<string, number> = {};
        for (const e of ents) if (passes(e, f)) for (const v of new Set(s.facets[f](e))) c[v] = (c[v] ?? 0) + 1;
        out[f] = c;
      }
      return { out, n: ents.filter((e) => passes(e)).length };
    };
    const combos: Record<string, string[]>[] = [
      {}, { type: ["savedSearch"] }, { type: ["savedSearch", "macro"], app: ["a"] },
      { app: ["b"], status: ["disabled"] }, { tag: ["x"], type: ["index"], app: ["c", "a"] }, { tag: ["nope"] },
    ];
    for (const f of combos) {
      const got = s.query("", f);
      const want = reference(f);
      expect(got.results.length).toBe(want.n);
      for (const facet of s.facetNames) expect(Object.fromEntries(got.facets[facet])).toEqual(want.out[facet]);
    }
  });
});

describe("byName", () => {
  const e = (id: string, name: string, displayName?: string) => ({ id, name, displayName, type: "index" }) as unknown as Entity;
  it("puts exact names first, then names that start with the query, keeping order within each", () => {
    const list = [e("a", "summary_main"), e("b", "main_backup"), e("c", "main"), e("d", "x", "Main")];
    expect(byName("main", list).map((x) => x.id)).toEqual(["c", "d", "b", "a"]);
  });
  it("leaves the list alone for an empty query", () => {
    const list = [e("a", "b"), e("c", "a")];
    expect(byName("  ", list)).toBe(list);
  });
});

describe("suggestions and one-pass queries (large catalogs)", () => {
  const entities = demoBundle().entities;
  const search = new EntitySearch(entities);

  it("suggests the first results of the query, in the same order", () => {
    for (const q of ["main", "web", "acme", "access", "x"]) {
      expect(search.suggest(q, 8).map((e) => e.id)).toEqual(search.query(q).results.slice(0, 8).map((e) => e.id));
    }
    expect(search.suggest("  ", 8)).toEqual([]);
  });

  it("counts what it hides in the same pass (as filtering the full results did)", () => {
    for (const q of ["", "time", "web"]) {
      for (const filters of [{}, { type: ["timeRange", "index"] }]) {
        const all = search.query(q, filters).results;
        const shown = search.query(q, filters, "relevance", isBuiltinSetting);
        expect(shown.hidden).toBe(all.filter(isBuiltinSetting).length);
        expect(shown.results.map((e) => e.id)).toEqual(all.filter((e) => !isBuiltinSetting(e)).map((e) => e.id));
      }
    }
  });

  it("reuses a match across filters, and matches again once the word index is complete", async () => {
    const s = new EntitySearch(entities);
    void s.indexInBackground(); // no step has run yet: names, apps and descriptions only
    expect(s.query("web").partial).toBe(true);
    expect(s.query("web", { type: ["index"] }).partial).toBe(true);
    await s.whenReady();
    const full = s.query("web");
    expect(full.partial).toBeUndefined();
    expect(full.results.map((e) => e.id)).toEqual(new EntitySearch(entities).query("web").results.map((e) => e.id));
  });
});
