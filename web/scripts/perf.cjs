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

const args = process.argv.slice(2);
// --budget <file>: fail (exit 1) when a step takes longer than its budget, fails, or the
// page logs an error (CI runs this on a synthetic catalog).
const budgetAt = args.indexOf("--budget");
const budget = budgetAt >= 0 ? JSON.parse(fs.readFileSync(args.splice(budgetAt, 2)[1], "utf8")) : null;
const [BASE = "http://localhost:4173", DIR = ".large", SERVED = "large/catalog.json"] = args;
let failed = 0;
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
    ["findings", () => nav("/findings", ".tiles")],
    ["health", () => nav("/health", "h1")],
    ["governance", () => nav("/governance", "h1")],
    ["insights", () => nav("/insights", ".kpi")],
    // Typing in the header search until suggestions show (includes 5 keys x 60 ms of typing),
    // once the word index is built (here, well after loading).
    ["header search typing", async () => {
      const box = page.locator(".search-box input");
      await box.fill("");
      await box.pressSequentially("index", { delay: 60 });
      await page.waitForSelector(".search-box [role=option]", { timeout: 60000 });
      await page.keyboard.press("Escape");
    }],
    ["sql console (Run usable)", () => nav("/sql", 'button.btn-primary:has-text("Run"):not([disabled])')],
  ];
  for (const [name, run] of steps) {
    const t = Date.now();
    try {
      await run();
      const ms = Date.now() - t;
      const limit = budget?.[name];
      const over = limit !== undefined && ms > limit;
      if (over) failed++;
      console.log(name.padEnd(22), `${String(ms).padStart(7)} ms`, `${String(await heap()).padStart(5)} MB heap`, limit !== undefined ? (over ? `OVER BUDGET (${limit} ms)` : `budget ${limit} ms`) : "");
    } catch (e) {
      failed++;
      console.log(name.padEnd(22), "FAIL", e.message.split("\n")[0].slice(0, 100));
    }
  }
  console.log(errors.length ? `console errors: ${errors.slice(0, 5).join(" | ")}` : "no console errors");
  if (errors.length) failed++;
  await browser.close();
  if (budget && failed) {
    console.log(`${failed} problem(s)`);
    process.exit(1);
  }
})();
