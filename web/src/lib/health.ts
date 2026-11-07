import type { Entity } from "../generated/catalog";

export type HealthStatus = "ok" | "warning" | "critical";

export const healthStatus = (e: Entity): HealthStatus => (e.health?.status as HealthStatus) ?? "ok";
export const isUnused = (e: Entity) => Boolean(e.usage?.unused);
export const isBuiltin = (e: Entity) => Boolean(e.usage?.builtin);

export interface DailySeries {
  start: string;
  counts: number[];
}

export function dailySeries(e: Entity): DailySeries | null {
  const obs = ((e.properties ?? {}) as Record<string, unknown>).observed as Record<string, unknown> | undefined;
  const d = obs?.dailyEvents as DailySeries | undefined;
  return d && Array.isArray(d.counts) && d.counts.length ? d : null;
}

export function dayLabel(start: string, offset: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * CSV with a header row; values are quoted so names with commas survive.
 * Text starting with = + - @ (or a tab / carriage return) gets a leading
 * apostrophe so spreadsheets show it instead of running it as a formula:
 * names and descriptions come from Splunk and annotations, not from us.
 */
export function toCsv(rows: (string | number | undefined)[][]): string {
  const q = (v: string | number | undefined) => {
    let s = String(v ?? "");
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export function downloadText(filename: string, text: string, type = "text/csv") {
  // A byte-order mark makes Excel read the CSV as UTF-8.
  const url = URL.createObjectURL(new Blob([type === "text/csv" ? `\ufeff${text}` : text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
