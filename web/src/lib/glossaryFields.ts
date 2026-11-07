import type { Entity, GlossaryTerm } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { fieldName } from "./fieldLineage";

/** Glossary terms of a field: annotated on it, or a term that lists its name. */
export function termsOfField(catalog: Catalog, f: Entity): string[] {
  const out = new Set(f.annotations?.glossaryTerms ?? []);
  const name = fieldName(f);
  for (const t of catalog.bundle.glossary ?? []) if (t.fields?.includes(name)) out.add(t.term);
  return [...out];
}

/** Every field in the catalog that carries a term. */
export function fieldsOfTerm(catalog: Catalog, term: GlossaryTerm): Entity[] {
  const names = new Set(term.fields ?? []);
  const labels = [term.term, ...(term.synonyms ?? [])].map((n) => n.toLowerCase());
  return catalog.entities.filter((e) => e.type === "field" && (
    names.has(fieldName(e)) || (e.annotations?.glossaryTerms ?? []).some((t) => labels.includes(t.toLowerCase()))
  ));
}
