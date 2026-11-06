import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";

export function TypeBadge({ entity }: { entity: Pick<Entity, "type"> }) {
  return <span className={`badge badge-${entity.type}`}>{typeLabel(entity.type)}</span>;
}

export function EntityRow({ entity }: { entity: Entity }) {
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
        {entity.owner && entity.owner !== "nobody" && <> · owner {entity.owner}</>}
        {entity.sharing && <> · {entity.sharing}</>}
      </div>
      {entity.description && <p className="entity-row-desc">{entity.description}</p>}
    </li>
  );
}
