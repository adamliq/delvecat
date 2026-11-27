/**
 * The SQL console's database: SQLite in a worker (sqlWorker.ts), so filling, indexing
 * and queries never stop the page from responding. One per loaded catalog, kept for the
 * session; a new catalog replaces it.
 *
 * Every table exists at once, empty; a table is filled the first time a query names it
 * (ensure), and entities and relationships are filled in the background once the console
 * is open (prefetch). Rows are built here from the catalog, a batch at a time, and sent
 * to the worker as JSON. Where the browser allows, the database is kept in its private
 * storage (OPFS): a later visit with the same catalog opens the filled tables at once.
 */
import type { Catalog } from "./catalog";
import { riskMap } from "./risk";
import { catalogTables, EDGE_INDEXES, needsEdgeIndexes, schemaStatements, tableIndexes, tablesIn, type QueryResult, type Table } from "./sql";
import type { OpenInfo, QueryOutput } from "./sqlEngine";
import type { Reply, Request } from "./sqlWorker";
import { SQL_DIR } from "./browserCache";

declare const __DELVECAT_BUILD__: string;

export interface LoadProgress {
  table: string;
  rows: number;
  done: number;
}

export interface CatalogDb {
  tables: Table[];
  /** Tables filled so far (including those kept from an earlier visit). */
  loaded: ReadonlySet<string>;
  /** Row counts of the filled tables. */
  counts: ReadonlyMap<string, number>;
  /** Where the tables are kept: in the browser's storage for later visits (and whether
   * they were kept from an earlier one), or for this visit only, and why. Can change
   * while filling (storage full). */
  storage: () => { saved: boolean; memoryReason?: string; reopened: boolean };
  /** Fill the tables a query names that are not filled yet. */
  ensure: (sql: string, onProgress?: (p: LoadProgress) => void) => Promise<void>;
  /** Fill entities and edges in the background, and index edges, once (after a short pause). */
  prefetch: (onProgress?: (p: LoadProgress) => void) => Promise<void>;
  /** Run a query (read-only); the last statement's result (its first MAX_ROWS rows). */
  query: (sql: string) => Promise<QueryResult>;
  /** Every row of a query's result as CSV. */
  csv: (sql: string) => Promise<Blob>;
  /** Stop whatever the database is doing (a long query); it opens again. */
  stop: () => Promise<void>;
  /** Delete the saved tables (keep: whether to keep tables in this browser from now on);
   * false when they could not be deleted (open in another tab). */
  clearSaved: (keep: boolean) => Promise<boolean>;
}

/** Rows per batch: about a million values (objects have 29 columns, relationships 4),
 * so each batch is built and sent in well under a tenth of a second. */
const batchFor = (t: Table) => Math.max(20000, Math.min(100000, Math.round(1_000_000 / t.columns.length)));
/** Batches sent ahead: the page builds the next while the worker inserts. */
const IN_FLIGHT = 3;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** What the saved database must match: this build of the app, this catalog and scope. */
export function catalogKey(bundle: Catalog["bundle"], tables: Table[]): string {
  const build = typeof __DELVECAT_BUILD__ === "string" ? __DELVECAT_BUILD__ : "dev";
  return [build, bundle.generatedAt, bundle.instances.map((i) => i.id).join(","), bundle.entities.length,
    bundle.edges.length, schemaStatements(tables).join(";")].join("|");
}

/** The database started again (storage full: now in memory; or Stop): fills restart. */
class Restarted extends Error {}
/** A query stopped with Stop. */
export class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

interface Conn {
  call: <T>(m: Request) => Promise<T>;
  close: (why: Error) => void;
}

function connect(onReset: () => void): Conn {
  const worker = new Worker(new URL("./sqlWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.value);
    else {
      if (ev.data.reset) onReset();
      p.reject(ev.data.reset ? new Restarted(ev.data.error) : new Error(ev.data.error));
    }
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "The SQL worker could not start.");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return {
    call: <T,>(m: Request): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ ...m, id });
      }),
    close: (why) => {
      worker.terminate();
      for (const p of pending.values()) p.reject(why);
      pending.clear();
    },
  };
}

let current: { catalog: Catalog; ready: Promise<CatalogDb>; close: () => void } | null = null;

export function catalogDb(catalog: Catalog): Promise<CatalogDb> {
  if (current?.catalog === catalog) return current.ready;
  current?.close();
  let closeNow = () => {};
  const ready = open(catalog, (close) => { closeNow = close; });
  current = { catalog, ready, close: () => closeNow() };
  return ready;
}

async function open(catalog: Catalog, onClose: (close: () => void) => void): Promise<CatalogDb> {
  const tables = catalogTables(catalog.bundle, () => riskMap(catalog)); // risk: only if queried
  const key = catalogKey(catalog.bundle, tables);
  const schema = schemaStatements(tables);
  const state = { saved: false, memoryReason: undefined as string | undefined, reopened: false };
  const loaded = new Set<string>();
  const counts = new Map<string, number>();
  let edgesIndexed = false;
  // Bumped whenever the database starts again (storage full, or Stop): a fill that sees
  // it change starts its table again, so no table is ever recorded with part of its rows.
  let epoch = 0;
  const restart = () => {
    epoch++;
    loaded.clear();
    counts.clear();
    edgesIndexed = false;
  };
  let conn: Conn;
  const start = async () => {
    conn = connect(() => {
      restart();
      state.saved = false;
      state.memoryReason = "the browser's storage is full";
      state.reopened = false;
    });
    const info = await conn.call<OpenInfo>({ op: "open", key, schema, save: keepSaved() });
    state.saved = info.saved;
    state.memoryReason = info.memoryReason;
    state.reopened = Object.keys(info.loaded).length > 0;
    for (const [t, n] of Object.entries(info.loaded)) {
      loaded.add(t);
      counts.set(t, n);
    }
    edgesIndexed = info.indexed.includes("edges");
  };
  await start();
  let closed = false; // another catalog replaced this one
  onClose(() => {
    closed = true;
    conn.close(new Restarted("closed"));
  });
  const call = <T,>(m: Request) => conn.call<T>(m);

  const filling = new Map<string, Promise<void>>();
  let waiting = 0; // queries waiting for a table: background fills give way meanwhile

  const fillOnce = async (t: Table, background: boolean, onProgress?: (p: LoadProgress) => void) => {
    const mine = epoch;
    const check = () => {
      if (epoch !== mine) throw new Restarted("the database started again");
    };
    const sliced = !!t.slice && !t.built && t.count !== undefined;
    const progress = (done: number) => onProgress?.({ table: t.name, rows: t.count ?? (t.built ? t.rows.length : 0), done });
    progress(0);
    await call({ op: "clear", table: t.name }); // what an unfinished fill left
    check();
    const total = sliced ? t.count! : t.rows.length;
    const inFlight: Promise<unknown>[] = [];
    const BATCH = batchFor(t);
    for (let i = 0; i < total; i += BATCH) {
      while (background && waiting > 0) await sleep(30);
      check();
      const end = Math.min(total, i + BATCH);
      const rows = sliced ? t.slice!(i, end) : t.rows.slice(i, end);
      inFlight.push(call({ op: "insert", table: t.name, ncols: t.columns.length, json: JSON.stringify(rows) }));
      if (inFlight.length >= IN_FLIGHT) await inFlight.shift(); // the next batches are built while one goes in
      check();
      progress((end / total) * 0.9);
      await sleep();
    }
    await Promise.all(inFlight);
    check();
    progress(0.95); // indexing
    await call({ op: "finish", table: t.name, indexes: tableIndexes(t), rows: total });
    check();
    loaded.add(t.name);
    counts.set(t.name, total);
    progress(1);
  };

  const fill = (t: Table, background: boolean, onProgress?: (p: LoadProgress) => void) => {
    let p = filling.get(t.name);
    if (!p) {
      p = (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await fillOnce(t, background, onProgress);
          } catch (e) {
            if (!(e instanceof Restarted) || attempt >= 2 || closed) throw e;
            if (loaded.has(t.name)) return; // filled again meanwhile
            await ready; // after Stop: the new database
          }
        }
      })().finally(() => filling.delete(t.name));
      filling.set(t.name, p);
    }
    return p;
  };

  const indexEdges = async (onProgress?: (p: LoadProgress) => void) => {
    if (edgesIndexed) return;
    const mine = epoch;
    onProgress?.({ table: "edges (indexing for joins)", rows: counts.get("edges") ?? 0, done: 0.95 });
    await call({ op: "index", group: "edges", statements: EDGE_INDEXES });
    if (epoch === mine) edgesIndexed = true;
  };

  // Tables a query needs: those loaded already cost nothing; one being loaded in the
  // background is waited for; others are loaded now, ahead of background loading.
  const ensure = async (sql: string, onProgress?: (p: LoadProgress) => void) => {
    await ready;
    const named = tablesIn(sql, tables);
    const need = named.filter((t) => !loaded.has(t.name));
    const wantsIndex = needsEdgeIndexes(sql) && named.some((t) => t.name === "edges");
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
    if (wantsIndex) await indexEdges(onProgress);
  };

  // Once the console is open and idle, load the two tables most queries use, and index
  // the relationships for joins, in the background (giving way to queries).
  let prefetching: Promise<void> | null = null;
  const prefetch = (onProgress?: (p: LoadProgress) => void) =>
    (prefetching ??= sleep(1500).then(async () => {
      for (const name of ["entities", "edges"]) {
        const t = tables.find((x) => x.name === name);
        if (t && !loaded.has(name)) await fill(t, true, onProgress).catch(() => undefined);
      }
      if (loaded.has("edges")) await indexEdges(onProgress).catch(() => undefined);
    }));

  // Stop: end the worker (whatever it is doing) and open the database again. Saved tables
  // come back at once; a fill that was under way starts again.
  let ready: Promise<void> = Promise.resolve();
  const stop = () => {
    restart();
    conn.close(new Stopped());
    ready = start();
    prefetching = null;
    return ready;
  };

  const query = async (sql: string): Promise<QueryResult> => {
    await ready;
    const r = await call<QueryOutput>({ op: "query", sql });
    return { columns: r.columns, rows: r.rows, total: r.total, ms: r.ms };
  };
  const csv = async (sql: string): Promise<Blob> => {
    await ready;
    return call<Blob>({ op: "csv", sql });
  };

  // Clear the saved tables (and, with keep false, stop keeping them in this browser): the
  // worker lets go of them first, then they are deleted and the database opens again.
  const clearSaved = async (keep: boolean) => {
    setKeepSaved(keep);
    restart();
    conn.close(new Stopped());
    let removed = true;
    try {
      const root = await navigator.storage?.getDirectory?.();
      for (let attempt = 0; root; attempt++) {
        try {
          await root.removeEntry(SQL_DIR, { recursive: true });
          break;
        } catch (e) {
          if ((e as Error).name === "NotFoundError") break;
          if (attempt >= 15) throw e; // still held: another tab
          await sleep(200); // the stopped worker lets go a moment later
        }
      }
    } catch {
      removed = false;
    }
    ready = start();
    prefetching = null;
    await ready;
    return removed;
  };

  return { tables, loaded, counts, storage: () => ({ ...state }), ensure, prefetch, query, csv, stop, clearSaved };
}

const KEEP_KEY = "delvecat.sql.keepTables";

/** Whether the console keeps its tables in this browser (on unless turned off). */
export function keepSaved(): boolean {
  try {
    return localStorage.getItem(KEEP_KEY) !== "no";
  } catch {
    return true;
  }
}

function setKeepSaved(keep: boolean) {
  try {
    if (keep) localStorage.removeItem(KEEP_KEY);
    else localStorage.setItem(KEEP_KEY, "no");
  } catch {
    /* not remembered: this visit only */
  }
}

/** Bytes the saved tables take in this browser's storage (OPFS), or undefined. */
export async function savedSize(): Promise<number | undefined> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return undefined;
    const dir = await root.getDirectoryHandle(SQL_DIR);
    const walk = async (d: FileSystemDirectoryHandle): Promise<number> => {
      let total = 0;
      for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        total += h.kind === "file" ? (await (h as FileSystemFileHandle).getFile()).size : await walk(h as FileSystemDirectoryHandle);
      }
      return total;
    };
    return await walk(dir);
  } catch {
    return undefined; // nothing saved
  }
}
