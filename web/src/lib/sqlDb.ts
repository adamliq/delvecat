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
  /** Run a query (read-only); the last statement's result. */
  query: (sql: string) => Promise<QueryResult>;
}

const BATCH = 20000;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** What the saved database must match: this build of the app, this catalog and scope. */
export function catalogKey(bundle: Catalog["bundle"], tables: Table[]): string {
  const build = typeof __DELVECAT_BUILD__ === "string" ? __DELVECAT_BUILD__ : "dev";
  return [build, bundle.generatedAt, bundle.instances.map((i) => i.id).join(","), bundle.entities.length,
    bundle.edges.length, schemaStatements(tables).join(";")].join("|");
}

class StorageReset extends Error {}

function connect() {
  const worker = new Worker(new URL("./sqlWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.value);
    else p.reject(ev.data.reset ? new StorageReset(ev.data.error) : new Error(ev.data.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "The SQL worker could not start.");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const call = <T,>(m: Request): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...m, id });
    });
  return { call, close: () => worker.terminate() };
}

let current: { catalog: Catalog; ready: Promise<CatalogDb>; close: () => void } | null = null;

export function catalogDb(catalog: Catalog): Promise<CatalogDb> {
  if (current?.catalog === catalog) return current.ready;
  current?.close();
  const w = connect();
  const ready = open(catalog, w.call);
  current = { catalog, ready, close: w.close };
  return ready;
}

async function open(catalog: Catalog, call: ReturnType<typeof connect>["call"]): Promise<CatalogDb> {
  const tables = catalogTables(catalog.bundle, () => riskMap(catalog)); // risk: only if queried
  const info = await call<OpenInfo>({ op: "open", key: catalogKey(catalog.bundle, tables), schema: schemaStatements(tables), save: true });
  const state = { saved: info.saved, memoryReason: info.memoryReason, reopened: Object.keys(info.loaded).length > 0 };
  const loaded = new Set(Object.keys(info.loaded));
  const counts = new Map(Object.entries(info.loaded));
  let edgesIndexed = info.indexed.includes("edges");
  const filling = new Map<string, Promise<void>>();
  let waiting = 0; // queries waiting for a table: background fills give way meanwhile

  const fillOnce = async (t: Table, background: boolean, onProgress?: (p: LoadProgress) => void) => {
    const sliced = !!t.slice && !t.built && t.count !== undefined;
    const progress = (done: number) => onProgress?.({ table: t.name, rows: t.count ?? (t.built ? t.rows.length : 0), done });
    progress(0);
    await call({ op: "clear", table: t.name }); // what an unfinished fill left
    const total = sliced ? t.count! : t.rows.length;
    const inFlight: Promise<unknown>[] = [];
    for (let i = 0; i < total; i += BATCH) {
      while (background && waiting > 0) await sleep(30);
      const end = Math.min(total, i + BATCH);
      const rows = sliced ? t.slice!(i, end) : t.rows.slice(i, end);
      inFlight.push(call({ op: "insert", table: t.name, ncols: t.columns.length, json: JSON.stringify(rows) }));
      if (inFlight.length >= 2) await inFlight.shift(); // the next batch is built while one goes in
      progress((end / total) * 0.9);
      await sleep();
    }
    await Promise.all(inFlight);
    progress(0.95); // indexing
    await call({ op: "finish", table: t.name, indexes: tableIndexes(t), rows: total });
    loaded.add(t.name);
    counts.set(t.name, total);
    progress(1);
  };

  const fill = (t: Table, background: boolean, onProgress?: (p: LoadProgress) => void) => {
    let p = filling.get(t.name);
    if (!p) {
      p = fillOnce(t, background, onProgress)
        .catch(async (e) => {
          if (!(e instanceof StorageReset)) throw e;
          // The browser's storage refused more: the worker now keeps it in memory, empty.
          state.saved = false;
          state.memoryReason = "the browser's storage is full";
          state.reopened = false;
          loaded.clear();
          counts.clear();
          edgesIndexed = false;
          await fillOnce(t, background, onProgress);
        })
        .finally(() => filling.delete(t.name));
      filling.set(t.name, p);
    }
    return p;
  };

  const indexEdges = async (onProgress?: (p: LoadProgress) => void) => {
    if (edgesIndexed) return;
    onProgress?.({ table: "edges (indexing for joins)", rows: counts.get("edges") ?? 0, done: 0.95 });
    await call({ op: "index", group: "edges", statements: EDGE_INDEXES });
    edgesIndexed = true;
  };

  // Tables a query needs: those loaded already cost nothing; one being loaded in the
  // background is waited for; others are loaded now, ahead of background loading.
  const ensure = async (sql: string, onProgress?: (p: LoadProgress) => void) => {
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

  const query = async (sql: string): Promise<QueryResult> => {
    const r = await call<QueryOutput>({ op: "query", sql });
    return { columns: r.columns, rows: r.rows, ms: r.ms };
  };

  return { tables, loaded, counts, storage: () => ({ ...state }), ensure, prefetch, query };
}
