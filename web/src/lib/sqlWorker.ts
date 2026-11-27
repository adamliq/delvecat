/// <reference lib="webworker" />
/**
 * The SQL console's database runs here, off the page: filling tables, indexing and
 * queries never stop the page from responding. Messages are answered in order.
 */
import sqlite3InitModule, { type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { SQL_DIR } from "./browserCache";
import { SqlEngine } from "./sqlEngine";

export type Request =
  | { op: "open"; key: string; schema: string[]; save: boolean }
  | { op: "clear"; table: string }
  | { op: "insert"; table: string; ncols: number; json: string }
  | { op: "finish"; table: string; indexes: string[]; rows: number }
  | { op: "index"; group: string; statements: string[] }
  | { op: "query"; sql: string }
  | { op: "csv"; sql: string };

export type Reply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: string; reset?: boolean };

let sqlite3: Sqlite3Static | undefined;
let engine: SqlEngine | undefined;
let opened: { key: string; schema: string[] } | undefined;

/** preserveOnInitFailure: a failed start (the files held by another tab, or by a worker
 * just stopped) must not delete the saved tables, which SQLite otherwise does.
 * forceReinitIfPreviouslyFailed: a retry tries again rather than repeating the failure. */
const POOL = {
  name: "delvecat-sql",
  directory: SQL_DIR,
  initialCapacity: 6,
  preserveOnInitFailure: true,
  forceReinitIfPreviouslyFailed: true,
} as Parameters<Sqlite3Static["installOpfsSAHPoolVfs"]>[0];

async function pool(): Promise<{ pool: SAHPoolUtil | null; reason?: string }> {
  if (!(self as unknown as { navigator: Navigator }).navigator.storage?.getDirectory) {
    return { pool: null, reason: "this browser does not offer the page storage here (it needs https or localhost)" };
  }
  // A worker just stopped (Stop) releases its hold on the files a moment later: try again
  // for a few seconds before deciding another tab has them.
  for (let attempt = 0; ; attempt++) {
    try {
      return { pool: await sqlite3!.installOpfsSAHPoolVfs(POOL) };
    } catch (e) {
      const locked = (e instanceof Error && e.name === "NoModificationAllowedError") || /lock|access handle/i.test(String(e));
      if (locked && attempt < 15) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      return { pool: null, reason: why(e) };
    }
  }
}

function why(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "QuotaExceededError" || /quota/i.test(msg)) return "the browser's storage for this site is full";
  if (name === "NoModificationAllowedError" || /lock|access handle/i.test(msg)) return "the saved copy is open in another tab";
  return `the browser's storage could not be used (${msg})`;
}

async function handle(m: Request): Promise<unknown> {
  if (m.op === "open") {
    sqlite3 ??= await sqlite3InitModule();
    const p = m.save ? await pool() : { pool: null, reason: "not requested" };
    engine = SqlEngine.open(sqlite3, m.key, m.schema, p.pool, p.reason);
    opened = { key: m.key, schema: m.schema };
    return engine.info;
  }
  if (!engine) throw new Error("The database is not open.");
  switch (m.op) {
    case "clear": return engine.clear(m.table);
    case "insert": return engine.insertJson(m.table, m.ncols, m.json);
    case "finish": return engine.finish(m.table, m.indexes, m.rows);
    case "index": return engine.index(m.group, m.statements);
    case "query": return engine.query(m.sql);
    case "csv": return engine.csv(m.sql);
  }
}

self.onmessage = async (ev: MessageEvent<Request & { id: number }>) => {
  const { id, ...m } = ev.data;
  try {
    (self as unknown as Worker).postMessage({ id, ok: true, value: await handle(m as Request) } satisfies Reply);
  } catch (e) {
    // "SQLITE_ERROR: sqlite3 result code 1: no such table: x" -> "no such table: x"
    const error = (e instanceof Error ? e.message : String(e)).replace(/^SQLITE_\w+: sqlite3 result code \d+: /, "");
    // The browser's storage failed (e.g. full): carry on in memory; the page fills again.
    if (engine?.info.saved && m.op !== "query" && m.op !== "csv" && SqlEngine.isStorageError(e) && sqlite3 && opened) {
      try { engine.close(); } catch { /* already closed */ }
      engine = SqlEngine.open(sqlite3, opened.key, opened.schema, null, `the browser's storage refused more data (${error})`);
      (self as unknown as Worker).postMessage({ id, ok: false, error, reset: true } satisfies Reply);
      return;
    }
    (self as unknown as Worker).postMessage({ id, ok: false, error } satisfies Reply);
  }
};
