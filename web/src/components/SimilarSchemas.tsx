import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";
import { similarSchemas } from "../lib/schema";
import { Meter } from "./Meter";

/** Sourcetypes and lookups whose field names overlap most with this one's. */
export function SimilarSchemas({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const similar = similarSchemas(catalog, entity);
  return (
    <section>
      <h2>Most similar schemas</h2>
      {similar.length === 0 ? <p className="muted">No sourcetype or lookup shares a field name with this one.</p> : (
        <div className="similar-grid">
          {similar.map((r) => (
            <div key={r.entity.id} className="similar-card">
              <div className="similar-top">
                <Link to={`${entityPath(r.entity.id)}?tab=fields`}>{r.entity.displayName ?? r.entity.name}</Link>
                <span className="muted small">{Math.round(r.score * 100)}% overlap</span>
              </div>
              {r.entity.type !== "sourcetype" && <span className="muted small">{typeLabel(r.entity.type)}</span>}
              <Meter value={Math.round(r.score * 100)} max={100} label={`${r.shared.length} shared`} name={`Field overlap with ${r.entity.name}`} />
              <p className="small similar-shared">{r.shared.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)}</p>
              <Link className="btn btn-small" to={`/compare?a=${encodeURIComponent(entity.id)}&b=${encodeURIComponent(r.entity.id)}`}>Compare schemas</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
