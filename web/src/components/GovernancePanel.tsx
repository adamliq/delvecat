import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { access, effectiveClassifications, HOW_LABEL, readsClassified, sensitiveAccess } from "../lib/governance";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";

export function GovernancePanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const classes = effectiveClassifications(entity);
  const a = access(entity);
  const reach = sensitiveAccess(entity);
  const reads = readsClassified(entity);
  if (!classes.length && !a && !reach.length && !reads.length) return null;
  const link = (id: string) => {
    const e = catalog.byId.get(id);
    return e ? <Link to={entityPath(id)}>{e.displayName ?? e.name}</Link> : id;
  };
  return (
    <section>
      <h2>Governance</h2>
      {classes.length > 0 && (
        <ul className="plain-list">
          {classes.map((c) => (
            <li key={c.name}>
              <span className={`chip${c.sensitive ? " chip-classification" : ""}`}>{c.name}</span>{" "}
              <span className="muted small">{HOW_LABEL[c.how]}{c.via ? <> · {link(c.via)}</> : null}{c.sensitive ? "" : " · not sensitive"}</span>
            </li>
          ))}
        </ul>
      )}
      {reads.length > 0 && <p className="small">Reads sensitive data: {reads.join(", ")}</p>}
      {a && (
        <dl className="facts">
          <dt>Roles with access</dt>
          <dd>{a.roles.map((r, i) => <span key={r}>{i > 0 && ", "}{link(r)}{a.filteredRoles.includes(r) && <span className="muted small"> (filtered)</span>}</span>)}</dd>
          <dt>Users with access</dt>
          <dd>{a.users.length ? a.users.map((u, i) => <span key={u}>{i > 0 && ", "}{link(u)}</span>) : <span className="muted">none</span>}</dd>
          {a.everyone && (<><dt>Exposure</dt><dd><span className="status-label status-warning">! Every role can reach it</span></dd></>)}
        </dl>
      )}
      {reach.length > 0 && (
        <>
          <h3>Sensitive data this {typeLabel(entity.type).toLowerCase()} can reach</h3>
          <ul className="plain-list">
            {reach.map((r) => (
              <li key={r.id}>
                {link(r.id)} <span className="muted small">{r.classifications.join(", ")} · {r.how === "read" ? "read permission" : r.filtered ? "search, filtered" : "search"}
                  {r.viaRoles?.length ? <> · via {r.viaRoles.map((v, i) => <span key={v}>{i > 0 && ", "}{link(v)}</span>)}</> : null}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
