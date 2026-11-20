/**
 * The SQL console's history and saved queries, kept in this browser only (per viewer).
 * Storage can be unavailable (private windows, blocked site data): everything degrades
 * to an empty list.
 */
const HISTORY = "delvecat.sql.history";
const SAVED = "delvecat.sql.saved";
export const HISTORY_SIZE = 50;

export interface HistoryItem {
  sql: string;
  at: string;
  rows?: number;
}

export interface SavedQuery {
  name: string;
  sql: string;
  at: string;
}

// When browser storage is unavailable, keep things for this page session at least.
const memory = new Map<string, string>();

function read<T>(key: string): T[] {
  let raw: string | null | undefined;
  try {
    raw = globalThis.localStorage?.getItem(key);
  } catch {
    raw = undefined;
  }
  try {
    const v = JSON.parse(raw ?? memory.get(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  const text = JSON.stringify(value);
  memory.set(key, text);
  try {
    globalThis.localStorage?.setItem(key, text);
  } catch {
    // storage full or blocked: the in-memory copy keeps working
  }
}

export const history = (): HistoryItem[] => read<HistoryItem>(HISTORY);

/** Add a query to the top of the history (moving it if already there). */
export function remember(sql: string, rows?: number): HistoryItem[] {
  const text = sql.trim();
  if (!text) return history();
  const next = [{ sql: text, at: new Date().toISOString(), rows }, ...history().filter((h) => h.sql !== text)].slice(0, HISTORY_SIZE);
  write(HISTORY, next);
  return next;
}

export function clearHistory(): void {
  write(HISTORY, []);
}

export const saved = (): SavedQuery[] => read<SavedQuery>(SAVED);

/** Save under a name (replacing one with the same name). */
export function save(name: string, sql: string): SavedQuery[] {
  const n = name.trim();
  if (!n) return saved();
  const next = [{ name: n, sql: sql.trim(), at: new Date().toISOString() }, ...saved().filter((s) => s.name !== n)];
  write(SAVED, next);
  return next;
}

export function unsave(name: string): SavedQuery[] {
  const next = saved().filter((s) => s.name !== name);
  write(SAVED, next);
  return next;
}
