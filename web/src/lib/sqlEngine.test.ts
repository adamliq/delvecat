import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { expandBundle, expandEdges, type EdgeTable } from "./catalog";
import { catalogTables, EDGE_INDEXES, EXAMPLES, fillDatabase, runQuery, schemaStatements, tableIndexes } from "./sql";
import { fileFor, splitStatements, SqlEngine } from "./sqlEngine";

const require = createRequire(import.meta.url);
const DIR = new URL("../../public/catalog/", import.meta.url);

/** The demo catalog with its shard files read in. */
function demo(): CatalogBundle {
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, DIR), "utf8"));
  const m = read("catalog.json") as CatalogBundle & { shards?: { path: string; kind: string }[] };
  const entities = [...m.entities];
  const edges = [...m.edges];
  for (const sh of m.shards ?? []) {
    const body = read(sh.path);
    if (body.edgeTable) expandEdges(body.edgeTable as EdgeTable, edges);
    else for (const x of body[sh.kind]) (sh.kind === "entities" ? entities : edges).push(x);
  }
  const { shards: _s, ...rest } = m;
  void _s;
  return expandBundle({ ...rest, entities, edges });
}
const bundle = demo();

let sqlite3: Sqlite3Static;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/** Fill every table the way the console does: JSON batches, then indexes. */
function filled(b: CatalogBundle = bundle) {
  const tables = catalogTables(b);
  const e = SqlEngine.open(sqlite3, "k1", schemaStatements(tables), null, "test");
  for (const t of tables) {
    for (let i = 0; i < t.rows.length; i += 50) e.insertJson(t.name, t.columns.length, JSON.stringify(t.rows.slice(i, i + 50)));
    e.finish(t.name, tableIndexes(t), t.rows.length);
  }
  e.index("edges", EDGE_INDEXES);
  return { e, tables };
}

describe("splitStatements", () => {
  it("splits where SQLite says a statement ends", () => {
    expect(splitStatements(sqlite3, "SELECT ';'; SELECT 2;\n-- done\n")).toEqual(["SELECT ';';", " SELECT 2;", "\n-- done\n"]);
    expect(splitStatements(sqlite3, "SELECT 1")).toEqual(["SELECT 1"]);
    expect(splitStatements(sqlite3, "  ;  ;")).toEqual([]);
  });
});

describe("SqlEngine", () => {
  it("fills from JSON batches with the same values as the rows", () => {
    const { e, tables } = filled();
    const ent = tables.find((t) => t.name === "entities")!;
    const r = e.query("SELECT * FROM entities ORDER BY rowid LIMIT 3");
    expect(r.columns).toEqual(ent.columns.map((c) => c.name));
    expect(r.rows).toEqual(ent.rows.slice(0, 3));
    expect(e.query("SELECT count(*) FROM edges").rows[0][0]).toBe(bundle.edges.length);
    expect(e.info.loaded.entities).toBe(ent.rows.length);
    expect(e.info.indexed).toEqual(["edges"]);
  });

  it("gives the same results as before (sql.js) for every example query", async () => {
    expect(bundle.entities.length).toBeGreaterThan(1000);
    const { e } = filled();
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const old = new SQL.Database();
    fillDatabase(old, catalogTables(bundle));
    let nonEmpty = 0;
    for (const x of EXAMPLES) {
      const before = runQuery(old, x.sql);
      const now = e.query(x.sql);
      // sql.js gives no column names when there are no rows; SQLite's own build does
      if (before.rows.length) expect(now.columns, x.title).toEqual(before.columns);
      expect(now.rows, x.title).toEqual(before.rows);
      if (now.rows.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(EXAMPLES.length / 2);
  });

  it("returns the last statement that has columns", () => {
    const { e } = filled();
    const r = e.query("SELECT 1 AS a; SELECT 2 AS b, 3 AS c;");
    expect(r.columns).toEqual(["b", "c"]);
    expect(r.rows).toEqual([[2, 3]]);
  });

  it("cannot be changed by a query", () => {
    const { e } = filled();
    for (const sql of [
      "DELETE FROM entities",
      "DROP TABLE edges",
      "PRAGMA query_only = 0; DELETE FROM entities",
      "ATTACH ':memory:' AS x",
      "CREATE TEMP TABLE t (a)",
    ]) {
      expect(() => e.query(sql), sql).toThrow();
    }
    expect(e.query("SELECT count(*) FROM entities").rows[0][0]).toBeGreaterThan(0);
    expect(e.query("PRAGMA table_info(edges)").rows.map((r) => r[1])).toEqual(["from_id", "to_id", "type", "origin"]);
  });

  it("empties a table whose fill did not finish", () => {
    const { e } = filled();
    e.clear("labels");
    expect(e.query("SELECT count(*) FROM labels").rows[0][0]).toBe(0);
    expect(e.info.loaded.labels).toBeDefined(); // the page refills it; the record goes on refill
  });

  it("starts in memory when no storage is given, and says why", () => {
    const e = SqlEngine.open(sqlite3, "k", ["CREATE TABLE a (x)"], null, "no storage here");
    expect(e.info).toEqual({ saved: false, memoryReason: "no storage here", loaded: {}, indexed: [] });
  });

  it("reopens the saved copy for the same catalog, and starts again otherwise", () => {
    const { pool, files } = fakePool();
    const schema = ["CREATE TABLE entities (id TEXT)"];

    const first = SqlEngine.open(sqlite3, "k1", schema, pool);
    expect(first.info).toMatchObject({ saved: true, loaded: {} });
    first.insertJson("entities", 1, '[["a"],["b"]]');
    first.finish("entities", [], 2);
    first.index("edges", []);

    const again = SqlEngine.open(sqlite3, "k1", schema, pool);
    expect(again.info).toEqual({ saved: true, loaded: { entities: 2 }, indexed: ["edges"] });
    expect(again.query("SELECT count(*) AS n FROM entities").rows).toEqual([[2]]);

    // a write that did not finish (the page closed): the copy may be damaged, so start again
    files.get(fileFor("k1"))!.exec("PRAGMA query_only = 0; INSERT OR REPLACE INTO delvecat_meta VALUES ('writing', '1')");
    const damaged = SqlEngine.open(sqlite3, "k1", schema, pool);
    expect(damaged.info.loaded).toEqual({});
    expect(damaged.query("SELECT count(*) AS n FROM entities").rows).toEqual([[0]]);
  });

  it("keeps the two most recently used catalogs (e.g. all stacks and one stack)", async () => {
    const { pool, files } = fakePool();
    const schema = ["CREATE TABLE entities (id TEXT)"];
    const fill = (key: string) => {
      const e = SqlEngine.open(sqlite3, key, schema, pool);
      if (!e.info.loaded.entities) {
        e.insertJson("entities", 1, '[["x"]]');
        e.finish("entities", [], 1);
      }
      return e;
    };
    const tick = () => new Promise((r) => setTimeout(r, 2));
    fill("all"); await tick();
    fill("stack-a"); await tick();
    expect(SqlEngine.open(sqlite3, "all", schema, pool).info.loaded).toEqual({ entities: 1 }); // switching back: kept
    await tick();
    fill("stack-b"); // a third: the least recently used (stack-a) goes
    expect([...files.keys()].sort()).toEqual([fileFor("all"), fileFor("stack-b")].sort());
    files.set("/delvecat-sql.sqlite3", new sqlite3.oo1.DB(":memory:")); // left by 0.45
    SqlEngine.open(sqlite3, "all", schema, pool);
    expect(files.has("/delvecat-sql.sqlite3")).toBe(false);
  });

  it("returns at most a limit of rows, counts them all, and gives them all as CSV", async () => {
    const { e } = filled();
    const sql = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) SELECT i, '=x' || i AS t FROM n";
    const r = e.query(sql, 1000);
    expect(r.rows).toHaveLength(1000);
    expect(r.total).toBe(2500);
    const csv = await e.csv(sql).text();
    const lines = csv.replace(/^\ufeff/, "").trim().split("\n");
    expect(lines).toHaveLength(2501);
    expect(lines[0]).toBe('"i","t"');
    expect(lines[2500]).toBe(`"2500","'=x2500"`);
  });
});

/** A stand-in for the OPFS pool: named files that outlive close(). */
function fakePool() {
  type Db = InstanceType<typeof sqlite3.oo1.DB>;
  const files = new Map<string, Db>();
  const realClose = new Map<Db, () => void>();
  const keep = (db: Db) => {
    if (!realClose.has(db)) {
      realClose.set(db, db.close.bind(db));
      Object.assign(db, { close: () => undefined });
    }
    return db;
  };
  const pool = {
    getFileNames: () => [...files.keys()],
    OpfsSAHPoolDb: function (name: string) {
      let db = files.get(name);
      if (!db) files.set(name, (db = new sqlite3.oo1.DB(":memory:")));
      return keep(db);
    },
    unlink: (name: string) => {
      const db = files.get(name);
      if (db) (realClose.get(db) ?? (() => db.close()))();
      return files.delete(name);
    },
  } as unknown as Parameters<typeof SqlEngine.open>[3];
  return { pool, files };
}
