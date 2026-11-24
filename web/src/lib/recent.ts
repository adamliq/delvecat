/** Objects recently opened, newest first, kept in this browser (ids only). */
const KEY = "delvecat.recent";
const MAX = 12;
const memory: string[] = [];

export function recentIds(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [...memory];
  } catch {
    return [...memory];
  }
}

export function rememberViewed(id: string): void {
  const list = [id, ...recentIds().filter((x) => x !== id)].slice(0, MAX);
  memory.splice(0, memory.length, ...list);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage blocked: kept for this page session
  }
}
