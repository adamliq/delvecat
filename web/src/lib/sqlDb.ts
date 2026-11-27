/**
 * One SQLite database per loaded catalog, kept for the session: reopening the SQL page
 * reuses it. A new catalog replaces (and closes) the previous one.
 *
 * The database opens at once with every table empty; a table is filled the first time a
 * query names it (ensure), in batches that let the page keep responding. Most queries
 * need only entities, so a large catalog (millions of relationships) does not have to be
 * copied in whole before the console can be used.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Catalog } from "./catalog";
import { riskMap } from "./risk";
import { catalogTables, createSchema, fillTable, tablesIn, type Table } from "./sql";

export interface LoadProgress {
  table: string;
  rows: number;
  done: number;
}

export interface CatalogDb {
  db: Database;
  tables: Table[];
  /** Tables filled so far. */
  loaded: ReadonlySet<string>;
  /** Fill the tables a query names that are not filled yet. */
  ensure: (sql: string, onProgress?: (p: LoadProgress) => void) => Promise<void>;
}

let current: { catalog: Catalog; ready: Promise<CatalogDb> } | null = null;

export function catalogDb(catalog: Catalog): Promise<CatalogDb> {
  if (current?.catalog === catalog) return current.ready;
  const previous = current;
  const ready = initSqlJs({ locateFile: () => wasmUrl }).then((SQL) => {
    const db = new SQL.Database();
    const tables = catalogTables(catalog.bundle, riskMap(catalog));
    createSchema(db, tables);
    db.run("PRAGMA query_only = 1");
    const loaded = new Set<string>();
    let queue = Promise.resolve();
    const ensure = (sql: string, onProgress?: (p: LoadProgress) => void) => {
      // One fill at a time, in order: two quick queries must not fill a table twice.
      const run = queue.catch(() => undefined).then(async () => {
        for (const t of tablesIn(sql, tables)) {
          if (loaded.has(t.name)) continue;
          db.run("PRAGMA query_only = 0");
          try {
            await fillTable(db, t, (done) => onProgress?.({ table: t.name, rows: t.count ?? (t.built ? t.rows.length : 0), done }));
            loaded.add(t.name);
          } catch (e) {
            db.run(`DELETE FROM ${t.name}`); // a partly filled table would be filled twice on the next try
            throw e;
          } finally {
            db.run("PRAGMA query_only = 1");
          }
        }
      });
      queue = run;
      return run;
    };
    return { db, tables, loaded, ensure };
  });
  current = { catalog, ready };
  void previous?.ready.then((p) => p.db.close()).catch(() => undefined);
  return ready;
}
