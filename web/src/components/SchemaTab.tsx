import { useState } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { CIM_REFERENCE_VERSION } from "../lib/cimReference";
import { fieldName } from "../lib/fieldLineage";
import { termsOfField } from "../lib/glossaryFields";
import { effectiveClassifications } from "../lib/governance";
import { entityPath, glossaryPath } from "../lib/routes";
import { cimCoverage, fieldType, nullRate, schemaFields, similarSchemas } from "../lib/schema";
import { Meter } from "./Meter";

type Filter = "all" | "number" | "string" | "cim" | "sensitive";

const FILTERS: [Filter, string][] = [["all", "All fields"], ["number", "Number"], ["string", "Text"], ["cim", "CIM"], ["sensitive", "Sensitive"]];

/** The schema of a sourcetype: typed fields with profile, tags and terms, and similar schemas. */
export function SchemaTab({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const [filter, setFilter] = useState<Filter>("all");
  const fields = schemaFields(catalog, entity);
  const cim = cimCoverage(catalog, entity);
  const similar = similarSchemas(catalog, entity);
  const readers = (f: Entity) => catalog.edgesTo(f.id).filter((x) => x.type === "readsField").length;
  const maxReaders = Math.max(1, ...fields.map(readers));
  const maxDistinct = Math.max(1, ...fields.map((f) => Number(((f.properties as { observed?: { distinctCount?: number } })?.observed ?? {}).distinctCount ?? 0)));
  const sensitive = (f: Entity) => effectiveClassifications(f).filter((c) => c.sensitive);
  const shown = fields.filter((f) =>
    filter === "all" || (filter === "cim" ? cim.cimFields.has(fieldName(f)) : filter === "sensitive" ? sensitive(f).length > 0 : fieldType(f) === filter));
  const count = (k: Filter) => fields.filter((f) =>
    k === "all" || (k === "cim" ? cim.cimFields.has(fieldName(f)) : k === "sensitive" ? sensitive(f).length > 0 : fieldType(f) === k)).length;

  return (
    <div className="stack">
      <dl className="schema-strip">
        <div><dt>Fields</dt><dd>{fields.length}</dd></div>
        <div>
          <dt>Data models</dt>
          <dd>{cim.models.length ? cim.models.map((m, i) => <span key={m.id}>{i > 0 && ", "}<Link to={entityPath(m.id)}>{m.displayName ?? m.name}</Link></span>)
            : <span className="muted">not mapped</span>}</dd>
        </div>
        <div>
          <dt>CIM coverage</dt>
          <dd>{cim.pct === undefined ? <span className="muted">n/a</span>
            : <Meter value={cim.pct} max={100} label={`${cim.pct}%`} name="Share of fields that are data model fields" />}</dd>
        </div>
        <div><dt>Sensitive fields</dt><dd>{fields.filter((f) => sensitive(f).length).length}</dd></div>
      </dl>
      {cim.fromReference && (
        <p className="muted small">Data model fields come from the built-in {CIM_REFERENCE_VERSION} reference: the data model in this catalog does not list its own.</p>
      )}

      <section>
        <div className="results-bar">
          <h2>Field schema</h2>
          <div className="view-switch" role="group" aria-label="Filter fields">
            {FILTERS.filter(([k]) => k === "all" || count(k) > 0).map(([k, label]) => (
              <button key={k} type="button" className={`btn btn-small${filter === k ? " btn-selected" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label} <span className="muted">{count(k)}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">From sampled events and props.conf. Null rate is the share of sampled events without the field.</p>
        <div className="table-wrap">
          <table className="mini-table schema-table">
            <thead><tr><th>Field</th><th>Type</th><th>Null rate</th><th>Distinct values</th><th>Tags</th><th>Glossary term</th><th>Used by</th></tr></thead>
            <tbody>
              {shown.map((f) => {
                const nr = nullRate(f);
                const distinct = ((f.properties as { observed?: { distinctCount?: number } })?.observed ?? {}).distinctCount;
                const terms = termsOfField(catalog, f);
                const n = readers(f);
                return (
                  <tr key={f.id}>
                    <td>
                      <Link to={entityPath(f.id)}><code>{fieldName(f)}</code></Link>
                      {(f.annotations?.description ?? f.description) && <div className="muted small">{f.annotations?.description ?? f.description}</div>}
                    </td>
                    <td><span className={`type-tag type-${fieldType(f)}`}>{fieldType(f) === "unknown" ? "config" : fieldType(f)}</span></td>
                    <td>{nr === undefined ? <span className="muted" title="Defined in props.conf, not seen in sampled events">—</span>
                      : <Meter value={Math.round(nr * 1000) / 10} max={100} label={`${Math.round(nr * 1000) / 10}%`} name={`Null rate of ${fieldName(f)}`} />}</td>
                    <td>{distinct === undefined ? <span className="muted">—</span>
                      : <Meter value={distinct} max={maxDistinct} label={distinct.toLocaleString()} name={`Distinct values of ${fieldName(f)}`} />}</td>
                    <td>
                      <span className="chips">
                        {sensitive(f).map((c) => <span key={c.name} className="chip chip-classification" title={c.how}>{c.name}</span>)}
                        {cim.cimFields.has(fieldName(f)) && <span className="chip chip-cim" title="A field of the data model this sourcetype feeds">CIM</span>}
                      </span>
                    </td>
                    <td>{terms.length ? terms.map((t, i) => <span key={t}>{i > 0 && ", "}<Link to={glossaryPath(t)}>{t}</Link></span>) : <span className="muted">—</span>}</td>
                    <td><Meter value={n} max={maxReaders} name={`Objects using ${fieldName(f)}`} label={n ? <Link to={entityPath(f.id)}>{n}</Link> : <span className="muted">0</span>} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Most similar schemas</h2>
        {similar.length === 0 ? <p className="muted">No other sourcetype shares a field name with this one.</p> : (
          <div className="similar-grid">
            {similar.map((r) => (
              <div key={r.entity.id} className="similar-card">
                <div className="similar-top">
                  <Link to={`${entityPath(r.entity.id)}?tab=fields`}>{r.entity.displayName ?? r.entity.name}</Link>
                  <span className="muted small">{Math.round(r.score * 100)}% overlap</span>
                </div>
                <Meter value={Math.round(r.score * 100)} max={100} label={`${r.shared.length} shared`} name={`Field overlap with ${r.entity.name}`} />
                <p className="small similar-shared">{r.shared.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)}</p>
                <Link className="btn btn-small" to={`/compare?a=${encodeURIComponent(entity.id)}&b=${encodeURIComponent(r.entity.id)}`}>Compare schemas</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
