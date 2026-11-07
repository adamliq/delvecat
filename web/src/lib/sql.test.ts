import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { catalogTables, EXAMPLES, fillDatabase, runQuery } from "./sql";

const require = createRequire(import.meta.url);
const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const idx = ent("index", "web", {
  properties: { datatype: "event", observed: { currentDBSizeMB: 12 } },
  annotations: { owners: ["web-team"], properties: { scope: ["PCI-DSS", "SOX"] }, missingProperties: ["tier"] },
  governance: { classifications: [{ name: "PII", sensitive: true, how: "annotated", derived: false }], access: { roles: ["*"], filteredRoles: [], users: ["bob"], everyone: true } },
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
});
