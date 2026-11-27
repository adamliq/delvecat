import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SqlEditor, type SqlEditorHandle } from "../components/SqlEditor";
import { SqlResults } from "../components/SqlResults";
import { useCatalog } from "../lib/CatalogContext";
import { EXAMPLES, VIEWS, type QueryResult, type Table } from "../lib/sql";
import { catalogDb, Stopped, type CatalogDb, type LoadProgress } from "../lib/sqlDb";
import { explainError, formatSql, jsonPaths, type ErrorHelp } from "../lib/sqlEditor";
import { EXAMPLE_GROUPS, exampleInfo } from "../lib/sqlExamples";
import * as store from "../lib/sqlStore";

type DbState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & CatalogDb);
type Side = "examples" | "tables" | "history" | "saved";

const when = (iso: string) => new Date(iso).toLocaleString();

export default function SqlPage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const [sql, setSql] = useState(params.get("q") ?? EXAMPLES[0].sql);
  const [db, setDb] = useState<DbState>({ status: "loading" });
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<ErrorHelp | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [side, setSide] = useState<Side>("examples");
  const [exampleFilter, setExampleFilter] = useState("");
  const [history, setHistory] = useState(store.history);
  const [savedQueries, setSaved] = useState(store.saved);
  const [copied, setCopied] = useState(false);
  const [filling, setFilling] = useState<LoadProgress | null>(null);
  const [background, setBackground] = useState<LoadProgress | null>(null);
  const [running, setRunning] = useState(false);
  const editor = useRef<SqlEditorHandle>(null);
  const lastRun = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDb({ status: "loading" });
    catalogDb(catalog)
      .then((d) => {
        if (cancelled) return;
        setDb({ status: "ready", ...d });
        void d.prefetch((p) => !cancelled && setBackground(p)).finally(() => !cancelled && setBackground(null));
      })
      .catch((e: unknown) => !cancelled && setDb({ status: "error", message: String(e) }));
    return () => {
      cancelled = true; // the database stays cached for the next visit
    };
  }, [catalog]);

  // Tables and views, for completion and highlighting in the editor.
  const tables = useMemo<Table[]>(
    () => (db.status === "ready" ? [...db.tables, ...VIEWS.map((v) => ({ name: v.name, doc: v.doc, columns: v.columns, rows: [], built: true }))] : []),
    [db],
  );

  const run = useCallback(async (text: string) => {
    if (db.status !== "ready") return;
    lastRun.current = text;
    setParams((p) => { const next = new URLSearchParams(p); next.set("q", text); return next; }, { replace: true });
    try {
      // Fill the tables this query uses (and entities, for the hints below) on first use.
      await db.ensure(`${text} entities`, setFilling);
    } catch (e) {
      setFilling(null);
      setError({ message: e instanceof Stopped ? "Stopped." : `Could not load the catalog into SQLite: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    setFilling(null);
    try {
      setRunning(true);
      const r = await db.query(text);
      setResult(r);
      setError(null);
      setHistory(store.remember(text, r.rows.length));
      // JSON paths the query reads from settings that no object has: likely a typo.
      const missing: string[] = [];
      for (const path of jsonPaths(text)) {
        try {
          const n = await db.query(`SELECT count(*) FROM entities WHERE json_extract(settings, '${path.replace(/'/g, "''")}') IS NOT NULL`);
          if (n.rows[0]?.[0] === 0) missing.push(path);
        } catch {
          /* not a valid path: the query's own error says so */
        }
      }
      setHints(missing.map((path) => `No object's settings contain ${path}: check the key (an object's Raw tab shows its properties).`));
    } catch (e) {
      setResult(null);
      setHints([]);
      setError(e instanceof Stopped ? { message: "Stopped." } : explainError(e instanceof Error ? e.message : String(e), text, db.tables));
    } finally {
      setRunning(false);
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

  const load = (text: string) => { setSql(text); run(text); };
  const copyLink = async () => {
    const url = new URL(window.location.href);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url.toString());
    }
  };
  const saveQuery = () => {
    const name = window.prompt("Save this query as", savedQueries.find((s) => s.sql === sql.trim())?.name ?? "");
    if (name) { setSaved(store.save(name, sql)); setSide("saved"); }
  };
  const fixError = (suggestion: string) => {
    const m = /no such (?:column|table|function): ([\w.]+)/i.exec(error?.message ?? "");
    if (!m) return;
    const name = m[1].split(".").pop()!;
    const fixed = sql.replace(new RegExp(`\\b${name}\\b`), suggestion);
    setSql(fixed);
    run(fixed);
  };

  const examples = useMemo(() => {
    const f = exampleFilter.trim().toLowerCase();
    const items = EXAMPLES.map((x) => ({ ...x, ...exampleInfo(x.title) }))
      .filter((x) => !f || `${x.title} ${x.description} ${x.group}`.toLowerCase().includes(f));
    return EXAMPLE_GROUPS.map((g) => [g, items.filter((x) => x.group === g)] as const).filter(([, xs]) => xs.length);
  }, [exampleFilter]);

  return (
    <div className="stack">
      <div>
        <h1>SQL console</h1>
        <p className="lede">Query the catalog with SQLite. It runs in your browser on the loaded catalog and cannot change anything.</p>
      </div>

      <div className="sql-layout">
        <div className="sql-main">
          <SqlEditor ref={editor} value={sql} onChange={setSql} onRun={() => run(sql)} tables={tables} errorLine={error?.line} />
          <div className="sql-actions">
            <button className="btn btn-primary" onClick={() => run(sql)} disabled={db.status !== "ready" || running}>Run</button>
            {(running || filling) && db.status === "ready" && (
              <button className="btn" onClick={() => { setFilling(null); void db.stop(); }} title="Stop the query; tables already loaded stay">Stop</button>
            )}
            <button className="btn" onClick={() => setSql(formatSql(sql))}>Format</button>
            <button className="btn" onClick={saveQuery} disabled={!sql.trim()}>Save…</button>
            <button className="btn" onClick={() => void copyLink()}>{copied ? "Link copied" : "Copy link"}</button>
            <span className="muted small">Ctrl+Enter to run · Tab to complete</span>
          </div>

          {db.status === "loading" && <p className="muted">Loading SQLite…</p>}
          {running && !filling && <p className="muted" role="status">Running…</p>}
          {filling && (
            <p className="muted" role="status">
              Loading table <code>{filling.table}</code>
              {filling.rows ? <> ({filling.rows.toLocaleString()} rows)</> : null}: {Math.round(filling.done * 100)}%
              {" "}· each table is loaded the first time a query uses it
            </p>
          )}
          {!filling && background && (
            <p className="muted small" role="status">
              Loading table <code>{background.table}</code> in the background: {Math.round(background.done * 100)}%
            </p>
          )}
          {db.status === "error" && <p className="error">Could not start SQLite: {db.message}</p>}
          {db.status === "ready" && (() => {
            const st = db.storage();
            return (
              <p className="muted small">
                {st.saved
                  ? st.reopened
                    ? "Tables kept in this browser from your last visit: they open at once until a new catalog is published."
                    : "Tables are kept in this browser once filled, so your next visit opens them at once."
                  : `Tables are filled for this visit only: ${st.memoryReason ?? "the browser's storage is not available"}.`}
              </p>
            );
          })()}
          {error && (
            <div className="error sql-error" role="alert">
              <div>{error.message}{error.line ? <span className="muted small"> · line {error.line}, column {error.column}</span> : null}</div>
              {error.suggestion && (
                <div>
                  Did you mean <code>{error.suggestion}</code>?{" "}
                  <button type="button" className="btn btn-small" onClick={() => fixError(error.suggestion!)}>Use {error.suggestion}</button>
                </div>
              )}
            </div>
          )}
          {hints.map((h) => <p key={h} className="notice small">{h}</p>)}
          {result && <SqlResults result={result} ids={catalog.byId} downloadAll={db.status === "ready" && lastRun.current ? () => db.csv(lastRun.current!) : undefined} />}
        </div>

        <aside className="sql-schema" aria-label="Examples, tables, history and saved queries">
          <div className="seg sql-side-tabs" role="tablist">
            {(["examples", "tables", "history", "saved"] as Side[]).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={side === s} className={side === s ? "active" : undefined} onClick={() => setSide(s)}>
                {s === "examples" ? "Examples" : s === "tables" ? "Tables" : s === "history" ? "History" : `Saved${savedQueries.length ? ` (${savedQueries.length})` : ""}`}
              </button>
            ))}
          </div>

          {side === "examples" && (
            <div className="sql-examples-list">
              <input type="search" placeholder="Search examples" aria-label="Search examples" value={exampleFilter} onChange={(e) => setExampleFilter(e.target.value)} />
              {examples.map(([group, xs]) => (
                <div key={group}>
                  <div className="facet-group-title">{group}</div>
                  <ul className="plain-list">
                    {xs.map((x) => (
                      <li key={x.title}>
                        <button type="button" className="link-btn sql-example" onClick={() => load(x.sql)}>{x.title}</button>
                        {x.description && <div className="muted small">{x.description}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {!examples.length && <p className="muted small">No example matches.</p>}
            </div>
          )}

          {side === "tables" && db.status === "ready" && db.tables.map((t) => (
            <details key={t.name}>
              <summary>
                <code>{t.name}</code> <span className="muted small">{db.counts.get(t.name)?.toLocaleString() ?? (t.built ? t.rows.length.toLocaleString() : t.count !== undefined ? t.count.toLocaleString() : "loads when used")}</span>
              </summary>
              <p className="small">{t.doc}</p>
              <ul className="plain-list small">
                <li><button type="button" className="link-btn" onClick={() => editor.current?.insert(t.name)} title="Insert at the cursor"><code>{t.name}</code></button> <span className="muted">insert the table name</span></li>
                {t.columns.map((c) => (
                  <li key={c.name}>
                    <button type="button" className="link-btn" onClick={() => editor.current?.insert(c.name)} title="Insert at the cursor"><code>{c.name}</code></button>{" "}
                    <span className="muted">{c.type.toLowerCase()}{c.doc ? ` · ${c.doc}` : ""}</span>
                  </li>
                ))}
              </ul>
              <button className="btn btn-small" onClick={() => load(`SELECT * FROM ${t.name} LIMIT 100;`)}>Preview</button>
            </details>
          ))}

          {side === "tables" && db.status === "ready" && VIEWS.map((v) => (
            <details key={v.name}>
              <summary><code>{v.name}</code> <span className="muted small">view</span></summary>
              <p className="small">{v.doc}</p>
              <ul className="plain-list small">
                {v.columns.map((c) => (
                  <li key={c.name}>
                    <button type="button" className="link-btn" onClick={() => editor.current?.insert(c.name)} title="Insert at the cursor"><code>{c.name}</code></button>{" "}
                    <span className="muted">{c.type.toLowerCase()}{c.doc ? ` · ${c.doc}` : ""}</span>
                  </li>
                ))}
              </ul>
              <button className="btn btn-small" onClick={() => load(`SELECT * FROM ${v.name} LIMIT 100;`)}>Preview</button>
            </details>
          ))}

          {side === "history" && (
            <div>
              {history.length === 0 ? <p className="muted small">Queries you run appear here (in this browser only).</p> : (
                <>
                  <ul className="plain-list sql-history">
                    {history.map((h) => (
                      <li key={h.sql}>
                        <button type="button" className="link-btn" onClick={() => load(h.sql)} title={h.sql}><code>{h.sql.replace(/\s+/g, " ").slice(0, 90)}</code></button>
                        <div className="muted small">{when(h.at)}{h.rows !== undefined ? ` · ${h.rows.toLocaleString()} rows` : ""}</div>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn btn-small" onClick={() => { store.clearHistory(); setHistory([]); }}>Clear history</button>
                </>
              )}
            </div>
          )}

          {side === "saved" && (
            savedQueries.length === 0 ? <p className="muted small">Save a query with <em>Save…</em>; saved queries stay in this browser.</p> : (
              <ul className="plain-list sql-history">
                {savedQueries.map((s) => (
                  <li key={s.name}>
                    <button type="button" className="link-btn" onClick={() => load(s.sql)} title={s.sql}>{s.name}</button>{" "}
                    <button type="button" className="link-btn muted small" onClick={() => setSaved(store.unsave(s.name))} aria-label={`Delete saved query ${s.name}`}>delete</button>
                    <div className="muted small"><code>{s.sql.replace(/\s+/g, " ").slice(0, 70)}</code></div>
                  </li>
                ))}
              </ul>
            )
          )}
        </aside>
      </div>
    </div>
  );
}
