import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { SqlValue } from "sql.js";
import type { QueryResult } from "../lib/sql";
import { entityPath } from "../lib/routes";
import { DataTable, type Column } from "./DataTable";
import { chartSpec, SqlChart } from "./SqlChart";

const SHOWN = 1000;

/** A cell: object ids link to the object; long JSON collapses to a preview. */
function Cell({ value, ids }: { value: SqlValue; ids: { has(id: string): boolean } }) {
  if (value === null) return <span className="muted">NULL</span>;
  if (value instanceof Uint8Array) return <span className="muted">(binary)</span>;
  const text = String(value);
  if (typeof value === "string" && ids.has(value)) return <Link to={entityPath(value)}>{value}</Link>;
  if (typeof value === "string" && text.length > 80 && /^[[{]/.test(text)) {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON after all: show as is
    }
    return (
      <details className="json-cell">
        <summary><code>{text.slice(0, 60)}…</code></summary>
        <pre>{pretty}</pre>
      </details>
    );
  }
  return <>{typeof value === "number" ? value.toLocaleString() : text}</>;
}

/** Query results: sortable and filterable table (CSV of all rows), or a chart when the
 * result is a label and a number. */
export function SqlResults({ result, ids, downloadAll }: {
  result: QueryResult;
  ids: { has(id: string): boolean };
  /** Every row as CSV, when the result was cut to its first rows. */
  downloadAll?: () => Promise<Blob>;
}) {
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const cut = result.total !== undefined && result.total > result.rows.length;
  const saveAll = async () => {
    if (!downloadAll) return;
    setSaving("Preparing the CSV…");
    try {
      const url = URL.createObjectURL(await downloadAll());
      const a = document.createElement("a");
      a.href = url;
      a.download = "delvecat-query.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaving(null);
    } catch (e) {
      setSaving(`Could not prepare the CSV: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const [view, setView] = useState<"table" | "chart">("table");
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? result.rows.filter((r) => r.some((v) => v !== null && !(v instanceof Uint8Array) && String(v).toLowerCase().includes(f))) : result.rows;
  }, [result, filter]);
  const spec = useMemo(() => chartSpec(result.columns, rows), [result.columns, rows]);
  const columns: Column<{ i: number; r: SqlValue[] }>[] = result.columns.map((c, j) => ({
    label: c || `column ${j + 1}`,
    value: ({ r }) => (r[j] instanceof Uint8Array ? "" : (r[j] as string | number | null)),
    render: ({ r }) => <Cell value={r[j]} ids={ids} />,
  }));
  const indexed = rows.map((r, i) => ({ i, r }));
  return (
    <div className="sql-results-wrap">
      <div className="sql-results-bar">
        <span className="muted small" role="status">
          {cut
            ? <>{result.total!.toLocaleString()} rows in {result.ms.toFixed(0)} ms: the first {result.rows.length.toLocaleString()} are here (sorting and the filter use these)</>
            : <>{result.rows.length.toLocaleString()} row{result.rows.length === 1 ? "" : "s"} in {result.ms.toFixed(0)} ms</>}
          {filter && <> · {rows.length.toLocaleString()} match the filter</>}
        </span>
        {cut && downloadAll && (
          <button type="button" className="btn btn-small" onClick={() => void saveAll()} disabled={saving === "Preparing the CSV…"}>
            Download all {result.total!.toLocaleString()} rows as CSV
          </button>
        )}
        {saving && <span className="muted small" role="status">{saving}</span>}
        <input type="search" className="sql-filter" placeholder="Filter results" aria-label="Filter results" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {spec && (
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={view === "table" ? "active" : undefined} aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
            <button type="button" className={view === "chart" ? "active" : undefined} aria-pressed={view === "chart"} onClick={() => setView("chart")}>Chart</button>
          </div>
        )}
      </div>
      {view === "chart" && spec ? (
        <SqlChart spec={spec} columns={result.columns} />
      ) : result.columns.length > 0 ? (
        <DataTable
          rows={indexed}
          rowKey={(x) => String(x.i)}
          columns={columns}
          csvName="delvecat-query.csv"
          limit={SHOWN}
          className="mini-table sql-results"
        />
      ) : (
        <p className="muted">The statement ran and returned no columns.</p>
      )}
    </div>
  );
}
