/**
 * The SQL console's database, in the worker (sqlWorker.ts) and in tests: SQLite's
 * official WebAssembly build. It is kept in the browser's private file storage (OPFS)
 * when the browser allows it, so a later visit to the console opens the tables already
 * filled instead of filling them again; otherwise (no OPFS, another tab holds it, or the
 * storage is full) in memory, as before.
 *
 * One saved database at a time, for one catalog (its key): another catalog replaces it.
 * Queries run with writes switched off (PRAGMA query_only), so they cannot change it;
 * only filling and indexing switch them on, between queries.
 */
import type { Database, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { csvCell } from "./csv";

export type Value = string | number | null | Uint8Array;

export interface QueryOutput {
  columns: string[];
  rows: Value[][];
  /** Rows the query gave (rows holds the first MAX_ROWS of them). */
  total: number;
  ms: number;
}

export interface OpenInfo {
  /** Kept in the browser's storage (OPFS) rather than in memory only. */
  saved: boolean;
  /** Why it is in memory only, when it is. */
  memoryReason?: string;
  /** Tables already filled (from an earlier visit), with their row counts. */
  loaded: Record<string, number>;
  /** Index groups already made (e.g. "edges"). */
  indexed: string[];
}

/** Saved databases are named by their catalog key; the two most recently used are kept
 * (e.g. all stacks and one stack), so switching scope does not refill. */
const PREFIX = "/delvecat-sql";
const KEEP = 2;
export const fileFor = (key: string) => `${PREFIX}-${fnv1a(key)}.sqlite3`;
/** Rows a query returns to the page; the rest are counted (and go to "Download all"). */
export const MAX_ROWS = 100_000;
const META = "delvecat_meta";
/** Pragmas that only describe the database (they take a table or index name). */
const READ_PRAGMAS = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo",
  "foreign_key_list", "function_list", "pragma_list", "collation_list", "compile_options", "database_list", "module_list"]);

/** Statements one by one, split where SQLite says a statement is complete (quotes,
 * comments and trigger bodies are handled by SQLite itself). */
export function splitStatements(sqlite3: Sqlite3Static, sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = sql.indexOf(";"); i >= 0; i = sql.indexOf(";", i + 1)) {
    const part = sql.slice(start, i + 1);
    if (sqlite3.capi.sqlite3_complete(part)) {
      if (part.replace(/;\s*$/, "").trim()) out.push(part);
      start = i + 1;
    }
  }
  if (sql.slice(start).trim()) out.push(sql.slice(start));
  return out;
}

export class SqlEngine {
  private constructor(
    private readonly sqlite3: Sqlite3Static,
    private db: Database,
    readonly info: OpenInfo,
  ) {
    // While a query runs, refuse what query_only does not: attaching other files, and
    // pragmas that set something (such as switching query_only off).
    const { capi } = sqlite3;
    capi.sqlite3_set_authorizer(db, (_p: number, code: number, a: string | 0, b: string | 0) => {
      if (!this.guarded) return 0;
      if (code === capi.SQLITE_ATTACH || code === capi.SQLITE_DETACH) return capi.SQLITE_DENY;
      if (code === capi.SQLITE_PRAGMA && b && !READ_PRAGMAS.has(String(a).toLowerCase())) return capi.SQLITE_DENY;
      return 0;
    }, 0);
  }

  private guarded = false;

  /**
   * Open the database for this catalog key: the saved one when it is for the same key,
   * else a new one with these tables. `pool` is the OPFS pool, or null for memory.
   */
  static open(sqlite3: Sqlite3Static, key: string, schema: string[], pool: SAHPoolUtil | null, memoryReason?: string): SqlEngine {
    if (pool) {
      const file = fileFor(key);
      try {
        SqlEngine.prune(pool, file);
        if (pool.getFileNames().includes(file)) {
          const db = new pool.OpfsSAHPoolDb(file);
          if (SqlEngine.savedKey(db) === key && !SqlEngine.unfinished(db)) {
            const e = new SqlEngine(sqlite3, db, { saved: true, loaded: {}, indexed: [] });
            db.exec("PRAGMA journal_mode = OFF;");
            e.tune();
            e.readMeta();
            e.touch();
            return e;
          }
          db.close();
          pool.unlink(file); // damaged, or not this catalog after all: start again
        }
        const fresh = new SqlEngine(sqlite3, new pool.OpfsSAHPoolDb(file), { saved: true, loaded: {}, indexed: [] });
        fresh.create(key, schema);
        fresh.touch();
        return fresh;
      } catch (e) {
        try { pool.unlink(file); } catch { /* nothing to remove */ }
        memoryReason = `the browser's storage could not be used (${message(e)})`;
      }
    }
    const mem = new SqlEngine(sqlite3, new sqlite3.oo1.DB(":memory:"), { saved: false, memoryReason, loaded: {}, indexed: [] });
    mem.create(key, schema);
    return mem;
  }

  /** Remove saved databases beyond the most recently used ones, keeping room for ``file``. */
  private static prune(pool: SAHPoolUtil, file: string) {
    const others = pool.getFileNames().filter((f) => f.startsWith(PREFIX) && f !== file);
    const keep = KEEP - 1; // and ``file``
    if (others.length <= keep) return;
    const used = others.map((f) => {
      let at = 0;
      try {
        const db = new pool.OpfsSAHPoolDb(f);
        try { at = Number(db.selectValue(`SELECT v FROM ${META} WHERE k = 'usedAt'`) ?? 0); } finally { db.close(); }
      } catch { /* not readable: oldest */ }
      return { f, at };
    }).sort((a, b) => b.at - a.at);
    for (const { f } of used.slice(keep)) pool.unlink(f);
  }

  /** Record this database as just used (for prune). */
  private touch() {
    this.write(() => this.db.exec({ sql: `INSERT OR REPLACE INTO ${META} VALUES ('usedAt', ?)`, bind: [String(Date.now())] }));
  }

  /** A write was under way when the page closed: writes skip the journal and syncing
   * (much faster; this is a copy that can be filled again), so the file may be damaged. */
  private static unfinished(db: Database): boolean {
    try {
      return !!db.selectValue(`SELECT 1 FROM ${META} WHERE k = 'writing'`);
    } catch {
      return true;
    }
  }

  private static savedKey(db: Database): string | undefined {
    try {
      return db.selectValue(`SELECT v FROM ${META} WHERE k = 'key'`) as string | undefined;
    } catch {
      return undefined; // empty file or not ours
    }
  }

  private create(key: string, schema: string[]) {
    this.db.exec("PRAGMA page_size = 65536; PRAGMA journal_mode = OFF;");
    this.tune();
    this.db.exec(`CREATE TABLE ${META} (k TEXT PRIMARY KEY, v TEXT)`);
    this.write(() => {
      for (const s of schema) this.db.exec(s);
      this.db.exec({ sql: `INSERT INTO ${META} VALUES ('key', ?)`, bind: [key] });
    });
  }

  private readMeta() {
    const rows = this.db.exec({ sql: `SELECT k, v FROM ${META}`, rowMode: "array", returnValue: "resultRows" }) as [string, string][];
    for (const [k, v] of rows) {
      if (k.startsWith("loaded:")) this.info.loaded[k.slice(7)] = Number(v);
      if (k.startsWith("indexed:")) this.info.indexed.push(k.slice(8));
    }
  }

  /** Fewer, larger reads and writes: the browser's file storage is slow per call. Sorting
   * (for indexes) stays in memory. */
  private tune() {
    this.db.exec("PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -131072;");
  }

  private readOnly(on: boolean) {
    this.db.exec(`PRAGMA query_only = ${on ? 1 : 0}`);
  }

  /** Run ``fn`` with writes allowed, in one transaction, marked as under way until done. */
  private write(fn: () => void) {
    this.readOnly(false);
    try {
      this.db.exec(`INSERT OR REPLACE INTO ${META} VALUES ('writing', '1')`);
      this.db.exec("BEGIN");
      try {
        fn();
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      }
      this.db.exec(`DELETE FROM ${META} WHERE k = 'writing'`);
    } finally {
      this.readOnly(true);
    }
  }

  /** Empty a table (a fill that did not finish, e.g. the page was closed meanwhile). */
  clear(table: string) {
    this.write(() => {
      this.db.exec(`DELETE FROM ${table}`);
      this.db.exec({ sql: `DELETE FROM ${META} WHERE k = ?`, bind: [`loaded:${table}`] });
    });
  }

  /** Add rows given as a JSON array of arrays: unpacked inside SQLite, one call a batch.
   * Each row is parsed once (into JSONB) before its columns are read: reading them from
   * the text would parse it again for every column (2.6 times slower for objects). */
  insertJson(table: string, ncols: number, json: string) {
    const cols = Array.from({ length: ncols }, (_, i) => `v->>${i}`).join(", ");
    this.write(() => this.db.exec({
      sql: `WITH r AS MATERIALIZED (SELECT jsonb(value) AS v FROM json_each(?)) INSERT INTO ${table} SELECT ${cols} FROM r`,
      bind: [json],
    }));
  }

  /** Record a table as filled (with its row count), after its indexes. */
  finish(table: string, indexes: string[], rows: number) {
    this.write(() => {
      for (const s of indexes) this.db.exec(s);
      this.db.exec({ sql: `INSERT OR REPLACE INTO ${META} VALUES (?, ?)`, bind: [`loaded:${table}`, String(rows)] });
    });
    this.info.loaded[table] = rows;
  }

  /** Make a group of indexes (e.g. on edges for joins), once. */
  index(group: string, statements: string[]) {
    if (this.info.indexed.includes(group)) return;
    this.write(() => {
      for (const s of statements) this.db.exec(s);
      this.db.exec({ sql: `INSERT OR REPLACE INTO ${META} VALUES (?, '1')`, bind: [`indexed:${group}`] });
    });
    this.info.indexed.push(group);
  }

  /** Run one or more statements, read-only; the last one that has columns is returned:
   * its first ``limit`` rows, and how many there are. */
  query(sql: string, limit = MAX_ROWS): QueryOutput {
    const start = performance.now();
    let last: { columns: string[]; rows: Value[][]; total: number } = { columns: [], rows: [], total: 0 };
    this.each(sql, (columns) => {
      const rows: Value[][] = [];
      last = { columns, rows, total: 0 };
      return (r) => {
        if (!r) return;
        last.total++;
        if (rows.length < limit) rows.push(r.map(plain));
      };
    });
    return { ...last, ms: performance.now() - start };
  }

  /** All rows of the last statement that has columns, as CSV (built in pieces: millions
   * of rows are more than one string can hold). */
  csv(sql: string): Blob {
    let parts: string[] = [];
    this.each(sql, (columns) => {
      parts = ["\ufeff", columns.map(csvCell).join(",") + "\n"];
      let chunk = "";
      return (r, done) => {
        if (r) chunk += r.map((v) => csvCell(plain(v))).join(",") + "\n";
        if (chunk.length > 1 << 20 || (done && chunk)) {
          parts.push(chunk);
          chunk = "";
        }
      };
    });
    return new Blob(parts, { type: "text/csv" });
  }

  /** Run each statement (read-only); for one that has columns, ``start`` gives a
   * function called with each row, then once with null when the statement is done. */
  private each(sql: string, start: (columns: string[]) => (row: unknown[] | null, done?: boolean) => void) {
    this.guarded = true;
    try {
      for (const stmt of splitStatements(this.sqlite3, sql)) {
        const q = this.db.prepare(stmt);
        try {
          const n = q.columnCount;
          if (!n) {
            while (q.step()) { /* no columns: nothing to show */ }
            continue;
          }
          const columns = q.getColumnNames();
          const row = start(columns);
          while (q.step()) row(q.get([]));
          row(null, true);
        } finally {
          q.finalize();
        }
      }
    } finally {
      this.guarded = false;
    }
  }

  /** Whether writes failed for lack of space or a storage error (then use memory). */
  static isStorageError(e: unknown): boolean {
    return /SQLITE_(FULL|IOERR|CANTOPEN|NOMEM)|quota/i.test(message(e));
  }

  close() {
    this.db.close();
  }
}

/** Results cross to the page as plain values (large integers as numbers). */
function plain(v: unknown): Value {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Int8Array || v instanceof ArrayBuffer) return new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer);
  return v as Value;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A short stable name for a key (file names). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + text.length.toString(16);
}
