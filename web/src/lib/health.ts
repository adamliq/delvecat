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

/** CSV with a header row; values are quoted so names with commas survive. */
export function toCsv(rows: (string | number | undefined)[][]): string {
  const q = (v: string | number | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export function downloadText(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
