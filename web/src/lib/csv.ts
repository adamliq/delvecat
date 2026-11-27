/**
 * One CSV value, quoted so names with commas survive. Text starting with = + - @ (or a
 * tab / carriage return) gets a leading apostrophe so spreadsheets show it instead of
 * running it as a formula: names and descriptions come from Splunk and annotations.
 */
export function csvCell(v: string | number | null | undefined | Uint8Array): string {
  if (v instanceof Uint8Array) return '""';
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
