import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { effectiveDescription, owners } from "../lib/annotate";
import { useCatalog, usePropertyDefs, useRisk } from "../lib/CatalogContext";
import { propLabel } from "../lib/propertyFormat";
import { highlightParts, matchSnippet, type Match } from "../lib/search";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { summaryChips } from "../lib/structured";
import { domainPath, entityPath, glossaryPath, productPath, searchPath } from "../lib/routes";

export function TypeBadge({ entity }: { entity: Pick<Entity, "type"> }) {
  return <span className={`badge badge-${entity.type}`}>{typeLabel(entity.type)}</span>;
}

/** Owners, tags, classifications and glossary terms as linked chips. */
export function AnnotationChips({ entity, compact = false }: { entity: Entity; compact?: boolean }) {
  const a = entity.annotations;
  if (!a) return null;
  const groups: [string, string, string[] | undefined, (v: string) => string][] = [
    ["domain", "Domain", a.domain ? [a.domain] : undefined, (v) => domainPath(v)],
    ["product", "Data product", a.dataProducts, (v) => productPath(v)],
    ["owner", "Owner", a.owners, (v) => searchPath({ owner: v })],
    ["classification", "Classification", a.classifications, (v) => searchPath({ classification: v })],
    ["tag", "Tag", a.tags, (v) => searchPath({ tag: v })],
    ["term", "Term", a.glossaryTerms, (v) => glossaryPath(v)],
  ];
  // Compact chips sit under a line that already names the owners.
  const items = groups.filter(([kind]) => !(compact && kind === "owner")).flatMap(([kind, label, values, to]) =>
    (values ?? []).map((v) => (
      <Link key={`${kind}:${v}`} to={to(v)} className={`chip chip-${kind}`} title={`${label}: ${v}`}>
        {!compact && <span className="chip-kind">{label}</span>}
        {v}
      </Link>
    )),
  );
  return items.length ? <span className="chips">{items}</span> : null;
}

/** Text with the matched words marked. */
export function Highlight({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length) return <>{text}</>;
  return <>{highlightParts(text, terms).map(([t, hit], i) => (hit ? <mark key={i}>{t}</mark> : <span key={i}>{t}</span>))}</>;
}

export function EntityRow({ entity, match }: { entity: Entity; match?: Match }) {
  const description = effectiveDescription(entity);
  const summary = summaryChips(usePropertyDefs(), entity);
  const risk = useRisk(entity.id);
  const { catalog } = useCatalog();
  const instances = catalog.bundle.instances;
  const instance = instances.length > 1 ? instances.find((i) => i.id === entity.instance)?.name ?? entity.instance : undefined;
  const snippet = matchSnippet(entity, match);
  return (
    <li className="entity-row">
      <div className="entity-row-head">
        <TypeBadge entity={entity} />
        <Link to={entityPath(entity.id)} state={{ from: `${window.location.hash.replace(/^#/, "") || "/"}` }} className="entity-name">
          <Highlight text={entity.displayName ?? entity.name} terms={match?.terms} />
        </Link>
        {entity.disabled && <span className="muted-tag">disabled</span>}
        {risk && (
          <span className={`status-label status-${risk.severity}`} title={`Depends on: ${risk.causes.map((c) => c.root.name).join(", ")}`}>
            At risk
          </span>
        )}
      </div>
      <div className="entity-row-meta">
        {PRODUCT_LABELS[entity.product]}
        {instance && <> · {instance}</>}
        {entity.app && <> · app <code>{entity.app}</code></>}
        {owners(entity).length > 0 && <> · owned by {owners(entity).join(", ")}</>}
        {entity.sharing === "user" && <> · private to {entity.owner}</>}
      </div>
      {description && <p className="entity-row-desc"><Highlight text={description} terms={match?.terms} /></p>}
      {snippet?.text && (
        <p className="match-snippet small">
          <span className="muted">Matched {snippet.key ? <>{propLabel(snippet.key)}</> : snippet.where}: </span>
          <code><Highlight text={snippet.text} terms={match?.terms} /></code>
        </p>
      )}
      <AnnotationChips entity={entity} compact />
      {summary.length > 0 && (
        <span className="chips">
          {summary.map((c) => <span key={c.id} className="chip chip-property">{c.text}</span>)}
        </span>
      )}
    </li>
  );
}
