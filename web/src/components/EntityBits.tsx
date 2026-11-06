import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { effectiveDescription, owners } from "../lib/annotate";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { entityPath, glossaryPath, searchPath } from "../lib/routes";

export function TypeBadge({ entity }: { entity: Pick<Entity, "type"> }) {
  return <span className={`badge badge-${entity.type}`}>{typeLabel(entity.type)}</span>;
}

/** Owners, tags, classifications and glossary terms as linked chips. */
export function AnnotationChips({ entity, compact = false }: { entity: Entity; compact?: boolean }) {
  const a = entity.annotations;
  if (!a) return null;
  const groups: [string, string, string[] | undefined, (v: string) => string][] = [
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

export function EntityRow({ entity }: { entity: Entity }) {
  const description = effectiveDescription(entity);
  return (
    <li className="entity-row">
      <div className="entity-row-head">
        <TypeBadge entity={entity} />
        <Link to={entityPath(entity.id)} className="entity-name">
          {entity.displayName ?? entity.name}
        </Link>
        {entity.disabled && <span className="muted-tag">disabled</span>}
      </div>
      <div className="entity-row-meta">
        {PRODUCT_LABELS[entity.product]}
        {entity.app && <> · app <code>{entity.app}</code></>}
        {owners(entity).length > 0 && <> · owned by {owners(entity).join(", ")}</>}
        {entity.sharing === "user" && <> · private to {entity.owner}</>}
      </div>
      {description && <p className="entity-row-desc">{description}</p>}
      <AnnotationChips entity={entity} compact />
    </li>
  );
}
