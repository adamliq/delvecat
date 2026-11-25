import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { holders, isHighRisk, roleCapabilities, userCapabilities } from "../lib/capabilities";
import { entityPath } from "../lib/routes";

const links = (list: Entity[], max = 30) => (
  <>
    {list.slice(0, max).map((e, i) => <span key={e.id}>{i > 0 && ", "}<Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link></span>)}
    {list.length > max && <span className="muted"> and {list.length - max} more</span>}
  </>
);

/** Capability names as links, high-risk ones first and marked. */
function CapList({ catalog, instance, names, from }: { catalog: Catalog; instance: string; names: string[]; from?: Map<string, string[]> }) {
  const caps = names.map((n) => ({ n, e: catalog.findOne(instance, "capability", n) }))
    .sort((a, b) => Number(isHighRisk(b.e)) - Number(isHighRisk(a.e)) || a.n.localeCompare(b.n));
  if (!caps.length) return <span className="muted">none</span>;
  return (
    <span className="chips">
      {caps.map(({ n, e }) => (
        <span key={n} className={`chip${isHighRisk(e) ? " chip-warn" : ""}`} title={[e?.description, from?.get(n)?.length ? `from ${from.get(n)!.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined}>
          {isHighRisk(e) && <span aria-hidden>! </span>}
          {e ? <Link to={entityPath(e.id)}>{n}</Link> : n}
        </span>
      ))}
    </span>
  );
}

/** On a capability: who holds it. On a role or user: what they may do. */
export function CapabilityPanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  if (entity.type === "capability") {
    const h = holders(catalog, entity);
    return (
      <section>
        <h2>Who holds it</h2>
        {isHighRisk(entity) && <p className="notice"><strong>! High risk:</strong> it lets a user {entity.description}.</p>}
        <dl className="facts">
          <dt>Roles granting it</dt><dd>{h.direct.length ? links(h.direct) : <span className="muted">none</span>}</dd>
          <dt>Roles inheriting it</dt><dd>{h.inherited.length ? links(h.inherited) : <span className="muted">none</span>}</dd>
          <dt>Users</dt><dd>{h.users.length ? <>{h.users.length} · {links(h.users, 20)}</> : <span className="muted">none in the catalog</span>}</dd>
        </dl>
      </section>
    );
  }
  if (entity.type === "role") {
    const { own, inherited } = roleCapabilities(entity);
    if (!own.length && !inherited.length) return null;
    const risky = [...own, ...inherited].filter((n) => isHighRisk(catalog.findOne(entity.instance, "capability", n)));
    return (
      <section>
        <h2>Capabilities <span className="muted">({own.length + inherited.length}{risky.length ? `, ${risky.length} high risk` : ""})</span></h2>
        <dl className="facts">
          <dt>Its own</dt><dd><CapList catalog={catalog} instance={entity.instance} names={own} /></dd>
          {inherited.length > 0 && <><dt>Inherited</dt><dd><CapList catalog={catalog} instance={entity.instance} names={inherited} /></dd></>}
        </dl>
        {risky.length > 0 && <p className="muted small">! marks capabilities that change who may do what, read secrets, run code, delete data or change the platform.</p>}
      </section>
    );
  }
  if (entity.type === "user") {
    const caps = userCapabilities(catalog, entity);
    const risky = [...caps.keys()].filter((n) => isHighRisk(catalog.findOne(entity.instance, "capability", n)));
    if (!caps.size) return null;
    return (
      <section>
        <h2>Capabilities <span className="muted">({caps.size} through their roles{risky.length ? `, ${risky.length} high risk` : ""})</span></h2>
        <CapList catalog={catalog} instance={entity.instance} names={risky.length ? risky : [...caps.keys()].slice(0, 40)} from={caps} />
        {risky.length > 0 && caps.size > risky.length && <p className="muted small">Showing the high-risk ones; the role pages list all of them.</p>}
      </section>
    );
  }
  return null;
}
