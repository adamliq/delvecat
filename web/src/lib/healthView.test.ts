import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { ackKey, ackLabel, browserStore, isHandled, splunkStore, type Ack } from "./acks";
import {
  REMEDIES, SECTIONS, ago, alertSeries, builtinApps, checkCounts, filterItems, groupRows, items, objectRows,
  problemSeries, reclaimableMB, searchLink, sectionOf, sizeText, thresholdText,
} from "./healthView";
import { CHECK_TITLES } from "./findings";

const NOW = "2026-11-20T09:00:00Z";

const ent = (id: string, type: string, checks: [string, "warning" | "critical", string?][], extra: Partial<Entity> = {}): Entity =>
  ({
    id: `acme:${type}:${id}`, type, name: id, instance: "acme", app: "acme_secops", owner: "alice",
    health: { status: checks.some((c) => c[1] === "critical") ? "critical" : "warning", checks: checks.map(([check, status, since]) => ({ check, status, message: `${check} here`, since })) },
    ...extra,
  }) as Entity;

const bundle = (history = 2): CatalogBundle =>
  ({ generatedAt: NOW, healthHistory: Array.from({ length: history }, (_, i) => ({ at: `2026-11-1${i}T00:00:00Z`, critical: 0, warning: 0 })) }) as unknown as CatalogBundle;

const ENTITIES = [
  ent("main", "index", [["freshness", "critical", NOW], ["volume", "warning", "2026-11-01T00:00:00Z"]]),
  ent("Brute", "savedSearch", [["alertNoisy", "warning", "2026-11-01T00:00:00Z"]], { owner: "bob", app: "SA-ES" }),
  ent("tok", "authToken", [["tokenStale", "warning", NOW]], { owner: undefined, properties: { user: "carol" } }),
  ent("odd", "lookup", [["somethingNew", "warning"]]),
];

describe("sections and remedies", () => {
  it("puts every known check in one section and unknown ones in Other", () => {
    const listed = SECTIONS.flatMap((s) => s.checks);
    expect(new Set(listed).size).toBe(listed.length);
    for (const check of Object.keys(CHECK_TITLES)) expect(sectionOf(check)).not.toBe("other");
    expect(sectionOf("somethingNew")).toBe("other");
  });

  it("has advice for every check, and searches quote names", () => {
    for (const check of Object.keys(CHECK_TITLES)) expect(REMEDIES[check], check).toBeDefined();
    const spl = REMEDIES.skipped.spl!({ ...ENTITIES[1], name: 'Say "hi"' } as Entity);
    expect(spl).toContain('savedsearch_name="Say \\"hi\\""');
    expect(spl).toContain('app="SA-ES"');
  });

  it("links a search to the instance's Splunk Web, this Splunk Web, or nowhere", () => {
    expect(searchLink("index=main", "https://sh:8000/", false)).toBe("https://sh:8000/app/search/search?q=search%20index%3Dmain");
    expect(searchLink("| tstats count", undefined, true, "/en-GB")).toBe("/en-GB/app/search/search?q=%7C%20tstats%20count");
    expect(searchLink("index=main", undefined, false)).toBeUndefined();
  });
});

describe("findings", () => {
  const all = items(ENTITIES, bundle(), new Map());

  it("marks new findings only when there is a build to compare with", () => {
    expect(all.filter((x) => x.isNew).map((x) => x.check).sort()).toEqual(["freshness", "tokenStale"]);
    expect(items(ENTITIES, bundle(1), new Map()).some((x) => x.isNew)).toBe(false);
  });

  it("filters by status, area, check, owner, app, text and new", () => {
    expect(filterItems(all, { status: "critical" }).map((x) => x.check)).toEqual(["freshness"]);
    expect(filterItems(all, { section: "data" })).toHaveLength(2);
    expect(filterItems(all, { owner: "carol" }).map((x) => x.check)).toEqual(["tokenStale"]);
    expect(filterItems(all, { app: "SA-ES" })).toHaveLength(1);
    expect(filterItems(all, { text: "noisy" })).toHaveLength(1);
    expect(filterItems(all, { onlyNew: true })).toHaveLength(2);
  });

  it("groups by object, worst first, and counts per check", () => {
    const rows = objectRows(all);
    expect(rows[0].entity.name).toBe("main");
    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].status).toBe("critical");
    const counts = checkCounts(all);
    expect(counts.find((c) => c.check === "freshness")).toMatchObject({ critical: 1, warning: 0, section: "data" });
  });

  it("summarises who needs to act", () => {
    const owners = groupRows(all, "owner");
    expect(owners[0]).toMatchObject({ key: "alice", critical: 1, warning: 2, objects: 2, newFindings: 1 });
    expect(owners.map((o) => o.key)).toContain("carol");
    expect(groupRows(all, "app").find((g) => g.key === "SA-ES")?.top).toEqual(["Noisy alert (1)"]);
  });
});

describe("acknowledgements", () => {
  const ack = (over: Partial<Ack>): Ack => ({ _key: "k", entity: "e", check: "c", state: "accepted", status: "warning", at: NOW, ...over });
  const now = new Date(NOW);

  it("hides accepted findings until they get worse, and snoozed ones until the date", () => {
    expect(isHandled(ack({}), "warning", now)).toBe(true);
    expect(isHandled(ack({}), "critical", now)).toBe(false);
    expect(isHandled(ack({ state: "snoozed", until: "2026-12-01T00:00:00Z" }), "warning", now)).toBe(true);
    expect(isHandled(ack({ state: "snoozed", until: "2026-11-01T00:00:00Z" }), "warning", now)).toBe(false);
    expect(ackLabel(ack({ by: "alice" }), now)).toBe("Accepted by alice");
    expect(ackLabel(ack({ state: "snoozed", until: "2026-11-01T00:00:00Z" }), now)).toMatch(/^Snooze ended/);
  });

  it("applies to the matching finding and can be shown again", () => {
    const e = ENTITIES[1];
    const map = new Map([[`${e.id}\u0000alertNoisy`, ack({ entity: e.id, check: "alertNoisy" })]]);
    const list = items(ENTITIES, bundle(), map);
    expect(filterItems(list, {}).some((x) => x.check === "alertNoisy")).toBe(false);
    expect(filterItems(list, { showHandled: true }).some((x) => x.check === "alertNoisy")).toBe(true);
  });

  it("keys are stable, short and differ per finding", () => {
    expect(ackKey("a", "b")).toBe(ackKey("a", "b"));
    expect(ackKey("a", "b")).not.toBe(ackKey("a", "c"));
    expect(ackKey("a", "b")).toMatch(/^ack-[0-9a-f]{16}$/);
  });

  it("keeps them in this browser outside Splunk", async () => {
    const saved = await browserStore.save({ entity: "e1", check: "c1", state: "accepted", status: "warning" });
    expect((await browserStore.list()).map((a) => a._key)).toContain(saved._key);
    await browserStore.remove(saved._key);
    expect(await browserStore.list()).toEqual([]);
  });

  it("writes to the app's KV collection with the form key in Splunk", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("current-context")) return new Response(JSON.stringify({ entry: [{ content: { username: "alice" } }] }));
      if (init?.method === "POST") return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    };
    const store = splunkStore(fetchFn);
    const a = await store.save({ entity: "e1", check: "c1", state: "snoozed", until: "2026-12-01T00:00:00Z", status: "warning" });
    expect(a.by).toBe("alice");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toContain("/storage/collections/data/delvecat_acks/batch_save");
    expect(JSON.parse(String(post.init!.body))[0]).toMatchObject({ _key: a._key, state: "snoozed" });
    await store.remove(a._key);
    expect(calls.at(-1)!.init!.method).toBe("DELETE");
    expect(calls.at(-1)!.url).toContain(`/delvecat_acks/${a._key}`);
  });

  it("explains who may acknowledge when Splunk refuses", async () => {
    const store = splunkStore(async (url) => (url.includes("current-context") ? new Response("{}") : new Response("", { status: 403 })));
    await expect(store.save({ entity: "e", check: "c", state: "accepted", status: "warning" })).rejects.toThrow(/delvecat_publisher/);
    expect(await store.list()).toEqual([]);
  });
});

describe("thresholds, series and cleanup", () => {
  it("states the build's thresholds, or the defaults", () => {
    expect(thresholdText(undefined)).toContain("stale after 24 hours (critical after 7 days)");
    expect(thresholdText({ staleWarningHours: 48, skipWarningRatio: 0.25 })).toMatch(/stale after 2 days.*more than 25% of scheduled runs skipped/);
  });

  it("reads daily problem runs and alert fires", () => {
    const e = { usage: { scheduler: { daily: { start: "2026-11-01", runs: [3, 3], problems: [0, 2] } }, alertDaily: { start: "2026-11-01", counts: [5, 9] } } } as unknown as Entity;
    expect(problemSeries(e)).toEqual({ start: "2026-11-01", counts: [0, 2] });
    expect(alertSeries(e)).toEqual({ start: "2026-11-01", counts: [5, 9] });
    expect(problemSeries({} as Entity)).toBeNull();
  });

  it("sizes, ages and built-in apps", () => {
    expect(reclaimableMB({ type: "index", properties: { observed: { currentDBSizeMB: 2048 } } } as unknown as Entity)).toBe(2048);
    expect(reclaimableMB({ type: "macro" } as Entity)).toBeUndefined();
    expect(sizeText(2048)).toBe("2.0 GB");
    expect(sizeText(12)).toBe("12 MB");
    expect(ago("2026-11-17T09:00:00Z", new Date(NOW))).toBe("3 days ago");
    expect(ago(undefined)).toBe("");
    const apps = builtinApps([
      { type: "app", name: "search", properties: { author: "Splunk" } },
      { type: "app", name: "SA-ES", product: "enterpriseSecurity" },
      { type: "app", name: "acme_web", product: "splunk", properties: { author: "acme" } },
    ] as unknown as Entity[]);
    expect([...apps].sort()).toEqual(["SA-ES", "search"]);
  });
});
