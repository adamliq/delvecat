import { useMemo, useState, type ReactNode } from "react";
import { downloadText, toCsv } from "../lib/health";

export interface Column<T> {
  /** Header text. */
  label: string;
  /** The value sorted on and written to CSV. */
  value: (row: T) => string | number | boolean | null | undefined;
  /** What the cell shows (defaults to the value). */
  render?: (row: T) => ReactNode;
  /** Not sortable (e.g. a chart). */
  noSort?: boolean;
  className?: string;
}

type Dir = "ascending" | "descending";

function compare(a: unknown, b: unknown): number {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1; // empty values last, whichever the direction
  if (empty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Sort rows by a column; empty values stay last. Exported for tests. */
export function sortRows<T>(rows: T[], col: Column<T> | undefined, dir: Dir): T[] {
  if (!col) return rows;
  const sign = dir === "ascending" ? 1 : -1;
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, ia], [b, ib]) => {
      const va = col.value(a);
      const vb = col.value(b);
      const emptyA = va === null || va === undefined || va === "";
      const emptyB = vb === null || vb === undefined || vb === "";
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      return sign * compare(va, vb) || ia - ib;
    })
    .map(([r]) => r);
}

/** A table whose columns sort on click and whose rows download as CSV. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  csvName,
  limit = 100,
  initialSort,
  className = "mini-table",
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** File name for "Download CSV"; no button without it. */
  csvName?: string;
  /** Rows shown (all of them go to the CSV). */
  limit?: number;
  initialSort?: { column: number; dir?: Dir };
  className?: string;
  empty?: ReactNode;
}) {
  // Large tables show a page at a time: rendering thousands of rows can exhaust the browser.
  const [shown, setShown] = useState(limit);
  const [sort, setSort] = useState<{ column: number; dir: Dir } | null>(
    initialSort ? { column: initialSort.column, dir: initialSort.dir ?? "ascending" } : null,
  );
  const sorted = useMemo(
    () => (sort ? sortRows(rows, columns[sort.column], sort.dir) : rows),
    [rows, columns, sort],
  );
  const toggle = (i: number) =>
    setSort((s) => (s?.column === i ? { column: i, dir: s.dir === "ascending" ? "descending" : "ascending" } : { column: i, dir: "ascending" }));
  const exportCsv = () =>
    downloadText(
      csvName!,
      toCsv([columns.map((c) => c.label), ...sorted.map((r) => columns.map((c) => {
        const v = c.value(r);
        return typeof v === "boolean" ? (v ? "yes" : "no") : (v ?? undefined) as string | number | undefined;
      }))]),
    );
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="data-table">
      {csvName && (
        <div className="data-table-bar">
          <span className="muted small">{rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}</span>
          <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!rows.length}>Download CSV</button>
        </div>
      )}
      <div className="table-wrap">
        <table className={className}>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c.label} className={c.className} aria-sort={sort?.column === i ? sort.dir : undefined}>
                  {c.noSort ? c.label : (
                    <button type="button" className="th-sort" onClick={() => toggle(i)}>
                      {c.label}
                      <span className="th-arrow" aria-hidden="true">{sort?.column === i ? (sort.dir === "ascending" ? "▲" : "▼") : "↕"}</span>
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => <td key={c.label} className={c.className}>{c.render ? c.render(r) : String(c.value(r) ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <p className="muted small table-more">
          Showing {shown.toLocaleString()} of {rows.length.toLocaleString()}{csvName ? "; the CSV has them all" : ""}.{" "}
          <button type="button" className="btn btn-small" onClick={() => setShown(shown + limit)}>
            Show {Math.min(limit, rows.length - shown).toLocaleString()} more
          </button>
        </p>
      )}
    </div>
  );
}
