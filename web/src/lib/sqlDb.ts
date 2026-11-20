/**
 * One SQLite database per loaded catalog, kept for the session: reopening the SQL page
 * reuses it instead of rebuilding it (seconds on large catalogs). A new catalog
 * replaces (and closes) the previous one.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Catalog } from "./catalog";
import { riskMap } from "./risk";
import { catalogTables, fillDatabase, type Table } from "./sql";

export interface CatalogDb {
  db: Database;
  tables: Table[];
}

let current: { catalog: Catalog; ready: Promise<CatalogDb> } | null = null;

export function catalogDb(catalog: Catalog): Promise<CatalogDb> {
  if (current?.catalog === catalog) return current.ready;
  const previous = current;
  const ready = initSqlJs({ locateFile: () => wasmUrl }).then((SQL) => {
    const db = new SQL.Database();
    const tables = catalogTables(catalog.bundle, riskMap(catalog));
    fillDatabase(db, tables);
    return { db, tables };
  });
  current = { catalog, ready };
  void previous?.ready.then((p) => p.db.close()).catch(() => undefined);
  return ready;
}
