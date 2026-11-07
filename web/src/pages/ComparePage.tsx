import { useSearchParams, Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { termsOfField } from "../lib/glossaryFields";
import { entityPath, glossaryPath } from "../lib/routes";
import { compareSchemas, fieldType, nullRate, schemaSourcetypes, type CompareStatus } from "../lib/schema";

const STATUS: Record<CompareStatus, { label: string; icon: string }> = {
  onlyA: { label: "Only in A", icon: "A" },
  same: { label: "Shared, same type", icon: "✓" },
  differs: { label: "Shared, type differs", icon: "!" },
  onlyB: { label: "Only in B", icon: "B" },
};
const ORDER: CompareStatus[] = ["onlyA", "same", "differs", "onlyB"];

const pct = (n?: number) => (n === undefined ? "—" : `${Math.round(n * 1000) / 10}%`);
const typeOf = (f?: Entity) => (f ? (fieldType(f) === "unknown" ? "config" : fieldType(f)) : undefined);

export function ComparePage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const options = schemaSourcetypes(catalog);
  const pick = (k: "a" | "b", fallback: number) => catalog.byId.get(params.get(k) ?? "") ?? options[fallback];
  const a = pick("a", 0);
  const b = pick("b", Math.min(1, options.length - 1));
  const filter = (params.get("show") as CompareStatus | null) ?? null;
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    if (!next.get("a") && a) next.set("a", a.id);
    if (!next.get("b") && b) next.set("b", b.id);
    setParams(next, { replace: true });
  };

  if (!a || !b || options.length < 2) {
    return (
      <div className="stack">
        <h1>Compare schemas</h1>
        <p className="muted">Comparing needs at least two sourcetypes with fields. Build the bundle with <code>--fields</code> to sample them.</p>
      </div>
    );
  }
  const rows = compareSchemas(catalog, a, b);
  const counts = Object.fromEntries(ORDER.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<CompareStatus, number>;
  const sharedPct = rows.length ? Math.round((100 * (counts.same + counts.differs)) / rows.length) : 0;
  const shown = filter ? rows.filter((r) => r.status === filter) : rows;
  const select = (k: "a" | "b", value: Entity) => (
    <select value={value.id} onChange={(e) => set(k, e.target.value)} aria-label={k === "a" ? "Schema A" : "Schema B"}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.displayName ?? o.name}{catalog.bundle.instances.length > 1 ? ` (${o.instance})` : ""}</option>)}
    </select>
  );

  return (
    <div className="stack">
      <div>
        <h1>Compare schemas</h1>
        <p className="lede">Which fields two sourcetypes share, and where the same field name holds a different type.</p>
      </div>
      <div className="cmp-pick">
        <label><span className="cmp-key cmp-a">A</span> {select("a", a)}</label>
        <button type="button" className="btn btn-small" onClick={() => { const next = new URLSearchParams(params); next.set("a", b.id); next.set("b", a.id); setParams(next, { replace: true }); }}>Swap</button>
        <label><span className="cmp-key cmp-b">B</span> {select("b", b)}</label>
      </div>
      <div className="tiles">
        <div className="tile static"><span className="tile-num">{sharedPct}%</span><span className="tile-label">of field names are shared</span></div>
        <div className="tile static"><span className="tile-num">{counts.same}</span><span className="tile-label">shared, same type</span></div>
        <div className="tile static"><span className="tile-num">{counts.differs}</span><span className="tile-label">shared, type differs</span></div>
        <div className="tile static"><span className="tile-num">{counts.onlyA} / {counts.onlyB}</span><span className="tile-label">only in A / only in B</span></div>
      </div>

      <figure className="segbar-figure">
        <div className="segbar" role="img" aria-label={ORDER.map((s) => `${STATUS[s].label}: ${counts[s]}`).join(", ")}>
          {ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className={`seg seg-${s}`} style={{ flexGrow: counts[s] }} title={`${STATUS[s].label}: ${counts[s]} (${Math.round((100 * counts[s]) / rows.length)}%)`}>
              {counts[s] / rows.length >= 0.06 && <span className="seg-label">{counts[s]}</span>}
            </span>
          ))}
        </div>
        <ul className="legend" aria-label="Legend">
          {ORDER.map((s) => <li key={s}><span className={`seg-swatch seg-${s}`} aria-hidden>{STATUS[s].icon}</span>{STATUS[s].label}</li>)}
        </ul>
      </figure>

      <section>
        <div className="results-bar">
          <h2>Field by field</h2>
          <div className="view-switch" role="group" aria-label="Show">
            <button type="button" className={`btn btn-small${!filter ? " btn-selected" : ""}`} aria-pressed={!filter} onClick={() => set("show", null)}>All {rows.length}</button>
            {ORDER.map((s) => (
              <button key={s} type="button" className={`btn btn-small${filter === s ? " btn-selected" : ""}`} aria-pressed={filter === s} onClick={() => set("show", s)}>
                {STATUS[s].label} {counts[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Field</th><th>Status</th><th>Type in A</th><th>Type in B</th><th>Null rate A / B</th><th>Glossary term</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={6} className="muted">No fields in this group.</td></tr>}
              {shown.map((r) => {
                const f = r.a ?? r.b!;
                const terms = termsOfField(catalog, f);
                return (
                  <tr key={r.name}>
                    <td><code>{r.name}</code></td>
                    <td><span className={`status-chip seg-chip-${r.status}`}><span aria-hidden>{STATUS[r.status].icon}</span> {STATUS[r.status].label}</span></td>
                    <td>{r.a ? <Link to={entityPath(r.a.id)}>{typeOf(r.a)}</Link> : <span className="muted">absent</span>}</td>
                    <td>{r.b ? <Link to={entityPath(r.b.id)}>{typeOf(r.b)}</Link> : <span className="muted">absent</span>}</td>
                    <td className="num">{r.a ? pct(nullRate(r.a)) : "–"} / {r.b ? pct(nullRate(r.b)) : "–"}</td>
                    <td>{terms.length ? terms.map((t, i) => <span key={t}>{i > 0 && ", "}<Link to={glossaryPath(t)}>{t}</Link></span>) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
