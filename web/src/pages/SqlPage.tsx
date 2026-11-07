import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { useCatalog } from "../lib/CatalogContext";
import { downloadText, toCsv } from "../lib/health";
import { entityPath } from "../lib/routes";
import { riskMap } from "../lib/risk";
import { catalogTables, EXAMPLES, fillDatabase, runQuery, type QueryResult, type Table } from "../lib/sql";

const SHOWN = 1000;

type DbState = { status: "loading" } | { status: "ready"; db: Database; tables: Table[] } | { status: "error"; message: string };

function Cell({ value, ids }: { value: SqlValue; ids: { has(id: string): boolean } }) {
  if (value === null) return <span className="muted">NULL</span>;
  if (value instanceof Uint8Array) return <span className="muted">[{value.length} bytes]</span>;
  const s = String(value);
  if (typeof value === "string" && ids.has(s)) return <Link to={entityPath(s)}>{s}</Link>;
  return s.length > 200 ? <span title={s}>{s.slice(0, 200)}…</span> : <>{s}</>;
}

export default function SqlPage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const [sql, setSql] = useState(params.get("q") ?? EXAMPLES[0].sql);
  const [db, setDb] = useState<DbState>({ status: "loading" });
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastRun = useRef<string | null>(null);

  useEffect(() => {
    let db: Database | undefined;
    let cancelled = false;
    setDb({ status: "loading" });
    initSqlJs({ locateFile: () => wasmUrl })
      .then((SQL) => {
        if (cancelled) return;
        db = new SQL.Database();
        const tables = catalogTables(catalog.bundle, riskMap(catalog));
        fillDatabase(db, tables);
        setDb({ status: "ready", db, tables });
      })
      .catch((e: unknown) => !cancelled && setDb({ status: "error", message: String(e) }));
    return () => {
      cancelled = true;
      db?.close();
    };
  }, [catalog]);

  const run = useCallback((text: string) => {
    if (db.status !== "ready") return;
    lastRun.current = text;
    setParams((p) => { const next = new URLSearchParams(p); next.set("q", text); return next; }, { replace: true });
    try {
      setResult(runQuery(db.db, text));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [db, setParams]);

  // Run the query in the link (shared links, back / forward) once the database is ready.
  const linked = params.get("q");
  useEffect(() => {
    if (db.status === "ready" && linked && linked !== lastRun.current) {
      setSql(linked);
      run(linked);
    }
  }, [db, linked, run]);

  const download = () => result && downloadText("delvecat-query.csv",
    toCsv([result.columns, ...result.rows.map((r) => r.map((v) => (v instanceof Uint8Array ? "" : (v ?? undefined))))]));

  return (
    <div className="stack">
      <div>
        <h1>SQL console</h1>
        <p className="lede">Query the catalog with SQLite. It runs in your browser on the loaded catalog and cannot change anything.</p>
      </div>

      <div className="sql-layout">
        <div className="sql-main">
          <label className="sql-examples">
            <span className="muted small">Examples</span>
            <select value="" onChange={(e) => { const x = EXAMPLES[Number(e.target.value)]; if (x) { setSql(x.sql); run(x.sql); } }}>
              <option value="">Choose an example query…</option>
              {EXAMPLES.map((x, i) => <option key={x.title} value={i}>{x.title}</option>)}
            </select>
          </label>
          <textarea
            className="sql-editor"
            aria-label="SQL query"
            spellCheck={false}
            wrap="off"
            value={sql}
            rows={8}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(sql); }
            }}
          />
          <div className="sql-actions">
            <button className="btn btn-primary" onClick={() => run(sql)} disabled={db.status !== "ready"}>Run</button>
            <span className="muted small">Ctrl+Enter to run</span>
            {result && result.rows.length > 0 && <button className="btn" onClick={download}>Download CSV</button>}
          </div>

          {db.status === "loading" && <p className="muted">Loading SQLite…</p>}
          {db.status === "error" && <p className="error">Could not start SQLite: {db.message}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {result && (
            <div>
              <p className="muted small" role="status">
                {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? "" : "s"} in {result.ms.toFixed(0)} ms
                {result.rows.length > SHOWN && <> · showing the first {SHOWN.toLocaleString()}; the CSV has them all</>}
              </p>
              {result.columns.length > 0 && (
                <div className="table-wrap">
                  <table className="mini-table sql-results">
                    <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.slice(0, SHOWN).map((r, i) => (
                        <tr key={i}>{r.map((v, j) => <td key={j}><Cell value={v} ids={catalog.byId} /></td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="sql-schema" aria-label="Tables">
          <h2>Tables</h2>
          {db.status === "ready" && db.tables.map((t) => (
            <details key={t.name}>
              <summary>
                <code>{t.name}</code> <span className="muted small">{t.rows.length.toLocaleString()}</span>
              </summary>
              <p className="small">{t.doc}</p>
              <ul className="plain-list small">
                {t.columns.map((c) => (
                  <li key={c.name}><code>{c.name}</code> <span className="muted">{c.type.toLowerCase()}{c.doc ? ` · ${c.doc}` : ""}</span></li>
                ))}
              </ul>
              <button className="btn btn-small" onClick={() => { const q = `SELECT * FROM ${t.name} LIMIT 100;`; setSql(q); run(q); }}>
                Preview
              </button>
            </details>
          ))}
        </aside>
      </div>
    </div>
  );
}
