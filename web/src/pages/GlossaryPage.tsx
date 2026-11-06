import { Link, useParams } from "react-router-dom";
import type { Entity, GlossaryTerm } from "../generated/catalog";
import { EntityRow } from "../components/EntityBits";
import { parseSource } from "../lib/annotate";
import { useCatalog } from "../lib/CatalogContext";
import { glossaryPath } from "../lib/routes";

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
            <dt><Link to={glossaryPath(t.term)}>{t.term}</Link> <span className="muted small">{count(t)} objects</span></dt>
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
