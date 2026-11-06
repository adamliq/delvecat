import { Link, useParams } from "react-router-dom";
import type { Edge } from "../generated/catalog";
import { TypeBadge } from "../components/EntityBits";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { entityPath, searchPath } from "../lib/routes";

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const LONG_TEXT = new Set(["search", "definition"]);

export function EntityPage() {
  const { id = "" } = useParams();
  const { catalog } = useCatalog();
  const entity = catalog.byId.get(id);

  if (!entity) {
    return (
      <div className="stack">
        <h1>Not found</h1>
        <p>No object with id <code>{id}</code> is in this bundle.</p>
      </div>
    );
  }

  const props = Object.entries(entity.properties ?? {});
  const code = props.filter(([k, v]) => LONG_TEXT.has(k) && typeof v === "string");
  const scalars = props.filter(([k]) => !LONG_TEXT.has(k));
  const related = (edges: Edge[], end: "from" | "to") =>
    edges.map((edge) => ({ edge, other: catalog.byId.get(edge[end]) })).filter((r) => r.other);
  const upstream = related(catalog.edgesTo(entity.id), "from");
  const downstream = related(catalog.edgesFrom(entity.id), "to");

  return (
    <div className="stack">
      <div>
        <TypeBadge entity={entity} />
        <h1 className="entity-title">{entity.displayName ?? entity.name}</h1>
        {entity.displayName && entity.displayName !== entity.name && (
          <div className="muted"><code>{entity.name}</code></div>
        )}
        <p className="fqn"><code>{entity.id}</code></p>
        {entity.description ? <p className="lede">{entity.description}</p> : <p className="muted">No description.</p>}
      </div>

      <dl className="facts">
        <dt>Product</dt><dd><Link to={searchPath({ product: entity.product })}>{PRODUCT_LABELS[entity.product]}</Link></dd>
        <dt>Instance</dt><dd>{entity.instance}</dd>
        {entity.app && (<><dt>App</dt><dd><Link to={searchPath({ app: entity.app })}>{entity.app}</Link></dd></>)}
        {entity.owner && (<><dt>Owner</dt><dd>{entity.owner}</dd></>)}
        {entity.sharing && (<><dt>Sharing</dt><dd>{entity.sharing}</dd></>)}
        <dt>Status</dt><dd>{entity.disabled ? "Disabled" : "Enabled"}</dd>
        {entity.updatedAt && (<><dt>Updated</dt><dd>{new Date(entity.updatedAt).toLocaleString()}</dd></>)}
      </dl>

      {code.map(([k, v]) => (
        <section key={k}>
          <h2>{k === "search" ? "SPL" : "Definition"}</h2>
          <pre className="code">{v as string}</pre>
        </section>
      ))}

      {scalars.length > 0 && (
        <section>
          <h2>Properties</h2>
          <dl className="facts">
            {scalars.map(([k, v]) => (
              <div key={k} className="fact-pair"><dt>{k}</dt><dd>{formatValue(v)}</dd></div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h2>Relationships</h2>
        {upstream.length + downstream.length === 0 && (
          <p className="muted">No relationships yet. SPL lineage arrives in Phase 3.</p>
        )}
        <ul className="plain-list">
          {upstream.map(({ edge, other }) => (
            <li key={`u-${other!.id}-${edge.type}`}>
              <Link to={entityPath(other!.id)}>{other!.displayName ?? other!.name}</Link>{" "}
              <span className="muted">({typeLabel(other!.type)}) {edge.type} this</span>
            </li>
          ))}
          {downstream.map(({ edge, other }) => (
            <li key={`d-${other!.id}-${edge.type}`}>
              <span className="muted">this {edge.type}</span>{" "}
              <Link to={entityPath(other!.id)}>{other!.displayName ?? other!.name}</Link>{" "}
              <span className="muted">({typeLabel(other!.type)})</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
