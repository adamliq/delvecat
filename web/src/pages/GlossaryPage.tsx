import { Link, useParams } from "react-router-dom";
import type { Entity, GlossaryTerm } from "../generated/catalog";
import { EntityRow } from "../components/EntityBits";
import { parseSource } from "../lib/annotate";
import { useCatalog } from "../lib/CatalogContext";
import type { Catalog } from "../lib/catalog";
import { fieldName } from "../lib/fieldLineage";
import { fieldsOfTerm } from "../lib/glossaryFields";
import { effectiveClassifications } from "../lib/governance";
import { entityPath, glossaryPath } from "../lib/routes";
import { fieldType, nullRate } from "../lib/schema";

/** Fields that carry a term, with the field names typed differently across sourcetypes. */
function termFields(catalog: Catalog, def: GlossaryTerm) {
  const fields = fieldsOfTerm(catalog, def).sort((a, b) => fieldName(a).localeCompare(fieldName(b)) || a.name.localeCompare(b.name));
  const types = new Map<string, Set<string>>();
  for (const f of fields) {
    const t = fieldType(f);
    if (t !== "unknown") types.set(fieldName(f), (types.get(fieldName(f)) ?? new Set()).add(t));
  }
  const inconsistent = [...types.entries()].filter(([, t]) => t.size > 1).map(([n]) => n);
  return { fields, inconsistent, sourcetypes: new Set(fields.map((f) => String((f.properties as { sourcetype?: string })?.sourcetype))) };
}

function usage(entities: Entity[]): Map<string, Entity[]> {
  const map = new Map<string, Entity[]>();
  for (const e of entities) {
    for (const t of e.annotations?.glossaryTerms ?? []) {
      const key = t.toLowerCase();
      map.set(key, [...(map.get(key) ?? []), e]);
    }
  }
  return map;
}

/** Resolve a term or one of its synonyms (case-insensitive). */
function findTerm(glossary: GlossaryTerm[], name: string): GlossaryTerm | undefined {
  const n = name.toLowerCase();
  return glossary.find((t) => t.term.toLowerCase() === n || t.synonyms?.some((s) => s.toLowerCase() === n));
}

export function GlossaryPage() {
  const { term } = useParams();
  const { catalog } = useCatalog();
  const glossary = catalog.bundle.glossary ?? [];
  const used = usage(catalog.entities);

  if (term) {
    const def = findTerm(glossary, term);
    const names = [def?.term ?? term, ...(def?.synonyms ?? [])].map((n) => n.toLowerCase());
    const entities = [...new Set(names.flatMap((n) => used.get(n) ?? []))];
    const src = catalog.bundle.annotationSource;
    const file = def?.source ? parseSource(def.source) : undefined;
    return (
      <div className="stack">
        <div>
          <span className="badge">Glossary term</span>
          <h1>{def?.term ?? term}</h1>
          {def?.description ? <p className="lede">{def.description}</p> : (
            <p className="muted">This term is used on objects but not defined in the glossary yet.</p>
          )}
          {def?.synonyms?.length ? <p className="small">Also called: {def.synonyms.join(", ")}</p> : null}
          {def?.owner ? <p className="small">Owned by {def.owner}</p> : null}
          {def?.related?.length ? (
            <p className="small">Related: {def.related.map((r, i) => (
              <span key={r}>{i > 0 && ", "}<Link to={glossaryPath(r)}>{r}</Link></span>
            ))}</p>
          ) : null}
          {src && file && (
            <p className="small">
              <a href={`${src.repoUrl}/edit/${encodeURIComponent(src.branch)}/${file.file}`} target="_blank" rel="noreferrer">
                Suggest an edit
              </a> <span className="muted">({def!.source})</span>
            </p>
          )}
        </div>
        {def && <TermFields catalog={catalog} def={def} />}
        <section>
          <h2>Objects using this term ({entities.length})</h2>
          <ul className="entity-list">{entities.map((e) => <EntityRow key={e.id} entity={e} />)}</ul>
        </section>
        <p><Link to={glossaryPath()}>← All terms</Link></p>
      </div>
    );
  }

  const defined = new Set(glossary.flatMap((t) => [t.term, ...(t.synonyms ?? [])].map((n) => n.toLowerCase())));
  const undefinedTerms = [...used.keys()].filter((k) => !defined.has(k));
  const count = (t: GlossaryTerm) =>
    new Set([t.term, ...(t.synonyms ?? [])].flatMap((n) => used.get(n.toLowerCase()) ?? [])).size;

  return (
    <div className="stack">
      <div>
        <h1>Glossary</h1>
        <p className="lede">Business terms used to describe Splunk data, maintained in the annotations folder.</p>
      </div>
      {glossary.length === 0 && <p className="muted">No glossary terms are defined in this bundle.</p>}
      <dl className="glossary">
        {glossary.map((t) => (
          <div key={t.term} className="glossary-item">
            <dt>
              <Link to={glossaryPath(t.term)}>{t.term}</Link> <span className="muted small">{count(t)} objects{t.fields?.length ? `, ${termFields(catalog, t).fields.length} fields` : ""}{t.owner ? `, owned by ${t.owner}` : ""}</span>
              {termFields(catalog, t).inconsistent.length > 0 && <> <span className="status-label status-warning">! Inconsistent type: {termFields(catalog, t).inconsistent.join(", ")}</span></>}
            </dt>
            <dd>{t.description ?? <span className="muted">No definition.</span>}</dd>
          </div>
        ))}
      </dl>
      {undefinedTerms.length > 0 && (
        <section>
          <h2>Used but not defined</h2>
          <ul className="plain-list">
            {undefinedTerms.map((k) => {
              const label = used.get(k)![0].annotations!.glossaryTerms!.find((t) => t.toLowerCase() === k)!;
              return <li key={k}><Link to={glossaryPath(label)}>{label}</Link></li>;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function TermFields({ catalog, def }: { catalog: Catalog; def: GlossaryTerm }) {
  const { fields, inconsistent, sourcetypes } = termFields(catalog, def);
  if (!fields.length && !def.fields?.length) return null;
  return (
    <section>
      <h2>Fields ({fields.length} in {sourcetypes.size} sourcetypes)</h2>
      {def.fields?.length ? <p className="muted small">Field names that carry this term: {def.fields.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)}</p> : null}
      {inconsistent.length > 0 && (
        <p><span className="status-label status-warning">! Inconsistent type</span> {inconsistent.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)}{" "}
          {inconsistent.length === 1 ? "is" : "are"} a number in some sourcetypes and text in others, so searches comparing values may miss events.</p>
      )}
      {fields.length === 0 ? <p className="muted">No sampled sourcetype has these fields.</p> : (
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Sourcetype</th><th>Field</th><th>Type</th><th>Null rate</th><th>Sensitive</th></tr></thead>
            <tbody>
              {fields.map((f) => {
                const st = String((f.properties as { sourcetype?: string })?.sourcetype ?? "");
                const nr = nullRate(f);
                const t = fieldType(f);
                return (
                  <tr key={f.id}>
                    <td><Link to={`${entityPath(`${f.instance}:sourcetype:${st}`)}?tab=fields`}>{st}</Link></td>
                    <td><Link to={entityPath(f.id)}><code>{fieldName(f)}</code></Link></td>
                    <td>{t === "unknown" ? "config" : t}{inconsistent.includes(fieldName(f)) && <span className="status-label status-warning small"> ! differs</span>}</td>
                    <td className="num">{nr === undefined ? "—" : `${Math.round(nr * 1000) / 10}%`}</td>
                    <td>{effectiveClassifications(f).filter((c) => c.sensitive).map((c) => c.name).join(", ") || <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
