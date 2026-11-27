import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { riskMap } from "./risk";
import { catalogTables, createSchema, EXAMPLES, fillDatabase, runQuery, tablesIn } from "./sql";

const require = createRequire(import.meta.url);
const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const idx = ent("index", "web", {
  properties: { datatype: "event", observed: { currentDBSizeMB: 12 } },
  annotations: { owners: ["web-team"], properties: { scope: ["PCI-DSS", "SOX"] }, missingProperties: ["tier"] },
  governance: { classifications: [{ name: "PII", sensitive: true, how: "annotated", derived: false }, { name: "PII.Email", sensitive: true, how: "lineage", derived: true, via: "i:savedSearch:x", columns: ["email", "user"] }], access: { roles: ["*"], filteredRoles: [], users: ["bob"], everyone: true } },
  health: { status: "warning", checks: [{ check: "freshness", status: "warning", message: "stale" }] },
});
const search = ent("savedSearch", "busy", { properties: { cronSchedule: "*/5 * * * *", isScheduled: true }, usage: { unused: true } });
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "Inst", kind: "splunkEnterprise" }],
  entities: [idx, search],
  edges: [{ from: search.id, to: idx.id, type: "reads", origin: "spl" }],
};

async function open() {
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database();
  fillDatabase(db, catalogTables(bundle));
  return db;
}

describe("SQL console", () => {
  it("flattens the bundle into tables", () => {
    const t = Object.fromEntries(catalogTables(bundle).map((x) => [x.name, x]));
    expect(t.entities.rows).toHaveLength(2);
    expect(t.properties.rows).toEqual([[idx.id, "scope", "PCI-DSS"], [idx.id, "scope", "SOX"]]);
    expect(t.settings.rows).toContainEqual([idx.id, "observed.currentDBSizeMB", 12]);
    expect(t.settings.rows).toContainEqual([search.id, "isScheduled", 1]);
    expect(t.access.rows).toEqual([[idx.id, "role", "*", 0], [idx.id, "user", "bob", 0]]);
    for (const x of Object.values(t)) for (const r of x.rows) expect(r).toHaveLength(x.columns.length);
  });

  it("answers queries, including JSON settings", async () => {
    const db = await open();
    const r = runQuery(db, "SELECT name, json_extract(settings, '$.cronSchedule') AS cron FROM entities WHERE type = 'savedSearch'");
    expect(r.columns).toEqual(["name", "cron"]);
    expect(r.rows).toEqual([["busy", "*/5 * * * *"]]);
    expect(runQuery(db, "SELECT sensitive, readable_by_everyone, health FROM entities WHERE type='index'").rows).toEqual([[1, 1, "warning"]]);
    expect(runQuery(db, "SELECT name, columns FROM classifications ORDER BY name").rows).toEqual([["PII", null], ["PII.Email", "email,user"]]);
  });

  it("is read-only", async () => {
    const db = await open();
    expect(() => runQuery(db, "DELETE FROM entities")).toThrow(/readonly|read-only|query_only/i);
    expect(runQuery(db, "SELECT count(*) FROM entities").rows).toEqual([[2]]);
  });

  it("runs every example", async () => {
    const db = await open();
    for (const x of EXAMPLES) expect(() => runQuery(db, x.sql), x.title).not.toThrow();
    expect(runQuery(db, EXAMPLES[0].sql).rows.map((r) => r[1])).toEqual(["busy"]);
  });

  it("lists alert email recipients", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const alert = {
      ...search,
      id: "t:savedSearch:app/mail",
      name: "mail",
      properties: { ...search.properties, alertRecipients: { to: ["a@x.example", "b@x.example"], cc: ["a@x.example"], from: "s@x.example" } },
    };
    const b = { ...bundle, entities: [...bundle.entities, alert] };
    fillDatabase(db, catalogTables(b, riskMap(new Catalog(b))));
    const rows = runQuery(db, EXAMPLES.find((x) => x.title === "Who alert emails go to")!.sql).rows;
    expect(rows.map((r) => [r[0], r[1], r[2]])).toEqual([
      ["a@x.example", "cc", 1],
      ["a@x.example", "to", 1],
      ["b@x.example", "to", 1],
    ]);
  });

  it("has a risk table", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    fillDatabase(db, catalogTables(bundle, riskMap(new Catalog(bundle))));
    expect(runQuery(db, "SELECT entity_id, severity, cause_id, hops FROM risk").rows).toEqual([[search.id, "warning", idx.id, 1]]);
    expect(runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Problems"))!.sql).rows[0][4]).toBe(1);
  });

  it("lists alerts by firings and tokens to review", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const alert = ent("savedSearch", "noisy", { usage: { alertFires: 900, alertsSuppressed: 3, alertWindow: "-30d" } });
    const quiet = ent("savedSearch", "quiet", { usage: { alertFires: 0, alertWindow: "-30d" } });
    const token = ent("authToken", "abc", {
      displayName: "CI (abc)",
      properties: { user: "ci", expiresAt: "2026-01-02T00:00:00Z" },
      health: { status: "critical", checks: [
        { check: "tokenExpiring", status: "warning", message: "soon" },
        { check: "tokenNoOwner", status: "critical", message: "gone" },
      ] },
    });
    fillDatabase(db, catalogTables({ ...bundle, entities: [alert, quiet, token, idx] }));
    const fires = runQuery(db, EXAMPLES.find((x) => x.title === "Alerts by how often they fire")!.sql).rows;
    expect(fires.map((r) => [r[0], r[3], r[4]])).toEqual([["noisy", 900, 3], ["quiet", 0, null]]);
    const tokens = runQuery(db, EXAMPLES.find((x) => x.title === "Authentication tokens to review")!.sql).rows;
    expect(tokens.map((r) => [r[0], r[1], r[4]])).toEqual([["CI (abc)", "ci", "tokenNoOwner"], ["CI (abc)", "ci", "tokenExpiring"]]);
  });

  it("lists index-time routing and federated indexes", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const st = ent("sourcetype", "fw", {
      properties: { indexTime: [
        { rule: "TRANSFORMS-a", transform: "to_risk", actions: ["routeToIndex"], targets: ["risk"] },
        { rule: "TRANSFORMS-b", transform: "drop_hb", actions: ["drop"], targets: [] },
      ] },
    });
    const prov = ent("federatedProvider", "remote", { properties: { providerType: "splunk" } });
    const fi = ent("federatedIndex", "federated:soc", {
      displayName: "soc", app: "sec", properties: { provider: "remote", datasetType: "index", dataset: "notable" },
    });
    fillDatabase(db, catalogTables({ ...bundle, entities: [st, prov, fi, search], edges: [{ from: search.id, to: fi.id, type: "reads", origin: "spl" }] }));
    const routing = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Data dropped"))!.sql).rows;
    expect(routing.map((r) => r[2])).toEqual(["drop_hb", "to_risk"]);
    const fed = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Federated indexes"))!.sql).rows;
    expect(fed).toEqual([["soc", "sec", "remote", "splunk", "index:notable", 1]]);
  });

  it("lists SPL2 modules with their readers and what they read", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const mod = ent("spl2Module", "web_errors", { app: "web", owner: "jlee", permissions: { read: ["power", "user"], write: ["admin"] } });
    fillDatabase(db, catalogTables({ ...bundle, entities: [mod, idx], edges: [{ from: mod.id, to: idx.id, type: "reads", origin: "config" }] }));
    const rows = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("SPL2 modules"))!.sql).rows;
    expect(rows).toEqual([["web", "web_errors", "jlee", "power, user", "index:web"]]);
  });

  it("lists external datastores with their connections", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const conn = ent("spl2Connection", "azure_lake_conn", { properties: { dataSource: "Azure", authMethods: ["servicePrincipal"] } });
    const ds = ent("spl2Dataset", "signin_archive", {
      app: "sec",
      properties: { kind: "azure_abs", dataSource: "Azure", connection: "azure_lake_conn", storageAccount: "lake", container: "logs", directory: "entra" },
    });
    fillDatabase(db, catalogTables({ ...bundle, entities: [conn, ds] }));
    const rows = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("External datastores"))!.sql).rows;
    expect(rows).toEqual([["sec", "signin_archive", "azure_abs", "Azure", "azure_lake_conn", '["servicePrincipal"]', "lake", "logs", "entra"]]);
  });

  it("lists detections muted, grouped or automated in ES", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const det = ent("correlationSearch", "Brute Force");
    const sup = ent("esSuppression", "Mute", { health: { status: "warning", checks: [{ check: "suppressesWholeDetection", status: "warning", message: "x" }] } });
    const auto = ent("esAutomationRule", "Enrich");
    fillDatabase(db, catalogTables({ ...bundle, entities: [det, sup, auto], edges: [
      { from: sup.id, to: det.id, type: "uses", origin: "config" },
      { from: auto.id, to: det.id, type: "uses", origin: "config" },
    ] }));
    const rows = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Detections muted"))!.sql).rows;
    expect(rows).toEqual([["Brute Force", "esAutomationRule", "Enrich", 0, null], ["Brute Force", "esSuppression", "Mute", 0, "suppressesWholeDetection"]]);
  });

  it("lists Microsoft add-on inputs with their accounts", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const acct = ent("addOnAccount", "acme_tenant", { properties: { tenantId: "t1", cloudEnvironment: "Worldwide" } });
    const inp = ent("input", "o365://audit", { properties: { index: "o365", microsoft: { addOn: "Office 365", service: "Management Activity", account: "acme_tenant" } } });
    const other = ent("input", "monitor:///var/log", { properties: { index: "main" } });
    fillDatabase(db, catalogTables({ ...bundle, entities: [acct, inp, other], edges: [{ from: inp.id, to: acct.id, type: "uses", origin: "config" }] }));
    const rows = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Microsoft add-on"))!.sql).rows;
    expect(rows).toEqual([["Office 365", "Management Activity", "o365://audit", 0, "o365", "acme_tenant", "t1", "Worldwide"]]);
  });

  it("lists outputs and acceleration summaries", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    const og = ent("outputGroup", "tcpout:siem", { displayName: "siem", properties: { kind: "tcpout", default: false, servers: ["a:9997"] } });
    const tr = ent("transform", "copy_to_siem");
    const big = ent("accelerationSummary", "DM_x", { displayName: "Data model acceleration: X", properties: { sizeMB: 900, completePercent: 100, accessCount: 0 }, usage: { unused: true } });
    const small = ent("accelerationSummary", "R1", { displayName: "Report acceleration: Y", properties: { sizeMB: 5, completePercent: 50, accessCount: 3 } });
    fillDatabase(db, catalogTables({ ...bundle, entities: [og, tr, big, small], edges: [{ from: tr.id, to: og.id, type: "writes", origin: "config" }] }));
    const outs = runQuery(db, EXAMPLES.find((x) => x.title === "Where data is forwarded")!.sql).rows;
    expect(outs).toEqual([["siem", "tcpout", 0, 0, '["a:9997"]', "copy_to_siem"]]);
    const sums = runQuery(db, EXAMPLES.find((x) => x.title.startsWith("Acceleration summaries"))!.sql).rows;
    expect(sums.map((r) => [r[0], r[1], r[5]])).toEqual([["Data model acceleration: X", 900, 1], ["Report acceleration: Y", 5, null]]);
  });
});

describe("tables filled on first use", () => {
  it("builds rows only when read, and finds the tables a query names", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const tables = catalogTables(bundle);
    const edges = tables.find((t) => t.name === "edges")!;
    expect(edges.built).toBe(false);
    expect(edges.count).toBe(bundle.edges.length);
    expect(tablesIn("SELECT * FROM entities e JOIN labels l ON l.entity_id = e.id WHERE e.name = 'edges'", tables).map((t) => t.name))
      .toEqual(["entities", "labels"]);
    const db = new SQL.Database();
    createSchema(db, tables);
    expect(runQuery(db, "SELECT count(*) FROM edges").rows[0][0]).toBe(0);
    expect(tables.find((t) => t.name === "entities")!.slice!(0, 2)).toHaveLength(2);
    expect(edges.built).toBe(false); // never read
  });
});
