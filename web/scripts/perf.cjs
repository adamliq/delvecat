#!/usr/bin/env node
/**
 * Time every page of the web app against a (large) catalog in headless Chromium.
 *
 *   node scripts/perf.cjs <app url> <catalog dir served under the app> [<served path>]
 *
 * e.g. node scripts/perf.cjs http://localhost:4173 .large large/catalog.json
 * Needs Playwright (require('playwright')). Prints one line per page: time from
 * navigation until the page has rendered, and the JS heap afterwards.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [BASE = "http://localhost:4173", DIR = ".large", SERVED = "large/catalog.json"] = process.argv.slice(2);
const shard = (type) => {
  const f = path.join(DIR, "entities", `${type}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).entities : [];
};
const first = (type, test = () => true) => shard(type).find(test)?.id;
const field = shard("field")[0];
const ids = {
  index: first("index"),
  sourcetype: field ? `${field.instance}:sourcetype:${field.properties.sourcetype}` : first("sourcetype"),
  search: first("savedSearch", (e) => e.properties?.search),
  field: field?.id,
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () => Math.round((await cdp.send("Performance.getMetrics")).metrics.find((x) => x.name === "JSHeapUsedSize").value / 1e6);
  const enc = encodeURIComponent;
  const nav = async (hash, sel) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(sel, { timeout: 120000 });
  };
  const steps = [
    ["load + home", async () => { await page.goto(`${BASE}/?bundle=${SERVED}#/`); await page.waitForSelector("h2", { timeout: 300000 }); }],
    ["search", async () => { await nav("/search", ".entity-row"); await page.fill(".search-box input", "detection"); await page.press(".search-box input", "Enter"); await page.waitForSelector(".entity-row"); }],
    ["browse with facets", () => nav("/search?type=savedSearch", ".entity-row")],
    ["index page", () => nav(`/entity/${enc(ids.index)}`, "h1")],
    ["index lineage", () => nav(`/entity/${enc(ids.index)}?tab=lineage`, ".lineage-node, .muted")],
    ["index relationships", () => nav(`/entity/${enc(ids.index)}?tab=relationships`, ".rel-head, .rel-grid")],
    ["sourcetype schema", () => nav(`/entity/${enc(ids.sourcetype)}?tab=fields`, ".schema-strip")],
    ["sourcetype lineage", () => nav(`/entity/${enc(ids.sourcetype)}?tab=lineage`, ".lineage-scroll")],
    ["search fields used", () => nav(`/entity/${enc(ids.search)}?tab=fieldsUsed`, "h2")],
    ["field page", () => nav(`/entity/${enc(ids.field)}`, "h1")],
    ["domains", () => nav("/domains", "h1")],
    ["schemas", () => nav("/schemas", ".network-svg, .muted")],
    ["glossary", () => nav("/glossary", "h1")],
    ["coverage", () => nav("/coverage", "h1")],
    ["health", () => nav("/health", "h1")],
    ["governance", () => nav("/governance", "h1")],
    ["insights", () => nav("/insights", ".kpi")],
    ["sql console", () => nav("/sql", ".sql-schema details")],
  ];
  for (const [name, run] of steps) {
    const t = Date.now();
    try {
      await run();
      console.log(name.padEnd(22), `${String(Date.now() - t).padStart(7)} ms`, `${String(await heap()).padStart(5)} MB heap`);
    } catch (e) {
      console.log(name.padEnd(22), "FAIL", e.message.split("\n")[0].slice(0, 100));
    }
  }
  console.log(errors.length ? `console errors: ${errors.slice(0, 5).join(" | ")}` : "no console errors");
  await browser.close();
})();
