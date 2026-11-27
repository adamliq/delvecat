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
  /** Load entities and edges in the background, once (after a short pause). */
  prefetch: (onProgress?: (p: LoadProgress) => void) => Promise<void>;
}

let current: { catalog: Catalog; ready: Promise<CatalogDb> } | null = null;

export function catalogDb(catalog: Catalog): Promise<CatalogDb> {
  if (current?.catalog === catalog) return current.ready;
  const previous = current;
  const ready = initSqlJs({ locateFile: () => wasmUrl }).then((SQL) => {
    const db = new SQL.Database();
    const tables = catalogTables(catalog.bundle, () => riskMap(catalog)); // risk: only if queried
    createSchema(db, tables);
    db.run("PRAGMA query_only = 1");
    const loaded = new Set<string>();
    const filling = new Map<string, Promise<void>>();
    let waiting = 0; // queries waiting for a table: background fills give way meanwhile
    const fill = (t: Table, background: boolean, onProgress?: (p: LoadProgress) => void) => {
      let p = filling.get(t.name);
      if (!p) {
        p = fillTable(db, t, (done) => onProgress?.({ table: t.name, rows: t.count ?? (t.built ? t.rows.length : 0), done }), background ? () => waiting > 0 : undefined)
          .then(() => { loaded.add(t.name); })
          .catch((e) => {
            db.run("PRAGMA query_only = 0");
            try { db.run(`DELETE FROM ${t.name}`); } finally { db.run("PRAGMA query_only = 1"); } // a partly filled table would be filled twice on the next try
            throw e;
          })
          .finally(() => filling.delete(t.name));
        filling.set(t.name, p);
      }
      return p;
    };
    // Tables a query needs: those loaded already cost nothing; one being loaded in the
    // background is waited for; others are loaded now, ahead of background loading.
    const ensure = async (sql: string, onProgress?: (p: LoadProgress) => void) => {
      const need = tablesIn(sql, tables).filter((t) => !loaded.has(t.name));
      if (!need.length) return;
      waiting++;
      try {
        for (const t of need) {
          if (loaded.has(t.name)) continue;
          const running = filling.get(t.name);
          if (running) {
            waiting--; // the table it waits for must not pause
            try { await running; } finally { waiting++; }
          } else {
            await fill(t, false, onProgress);
          }
        }
      } finally {
        waiting--;
      }
    };
    // Once the console is open and idle, load the two tables most queries use, in the
    // background (giving way to queries), so the first query on them does not wait.
    let prefetching: Promise<void> | null = null;
    const prefetch = (onProgress?: (p: LoadProgress) => void) =>
      (prefetching ??= new Promise<void>((r) => setTimeout(r, 1500)).then(async () => {
        for (const name of ["entities", "edges"]) {
          const t = tables.find((x) => x.name === name);
          if (t && !loaded.has(name)) await fill(t, true, onProgress).catch(() => undefined);
        }
      }));
    return { db, tables, loaded, ensure, prefetch };
  });
  current = { catalog, ready };
  void previous?.ready.then((p) => p.db.close()).catch(() => undefined);
  return ready;
}
