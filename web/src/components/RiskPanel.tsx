import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { typeLabel } from "../lib/labels";
import { atRiskFrom, riskMap, type RiskCause } from "../lib/risk";
import { entityPath } from "../lib/routes";

const SHOWN = 5;

const name = (e: Entity) => e.displayName ?? e.name;

function Cause({ c }: { c: RiskCause }) {
  return (
    <li>
      <span className="muted rel-type">{typeLabel(c.root.type)}</span> <Link to={entityPath(c.root.id)}>{name(c.root)}</Link>
      {": "}{c.problems.map((p) => p.summary).join("; ")}
      <span className="muted small">
        {" · "}
        {c.depth === 1 ? "direct dependency" : <>{c.depth} hops away, via {typeLabel(c.via!.type).toLowerCase()} <Link to={entityPath(c.via!.id)}>{name(c.via!)}</Link></>}
        {c.partial && " · one of several sources, so only partly affected"}
      </span>
    </li>
  );
}

/** Shown on an object that depends on something with a problem. */
export function RiskBanner({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const risk = riskMap(catalog).get(entity.id);
  if (!risk) return null;
  const n = risk.causes.length;
  return (
    <section className={`risk-banner risk-${risk.severity}`} aria-label="At risk">
      <p>
        <span className={`status-label status-${risk.severity}`}>{risk.severity === "critical" ? "✕" : "!"} At risk</span>{" "}
        Depends on {n === 1 ? "an object" : `${n} objects`} with problems, so it may be missing data or failing.
      </p>
      <ul className="plain-list small">
        {risk.causes.slice(0, SHOWN).map((c) => <Cause key={c.root.id} c={c} />)}
      </ul>
      {n > SHOWN && (
        <details>
          <summary className="small">{n - SHOWN} more</summary>
          <ul className="plain-list small">{risk.causes.slice(SHOWN).map((c) => <Cause key={c.root.id} c={c} />)}</ul>
        </details>
      )}
    </section>
  );
}

/** On an object with a problem: what its problem puts at risk. */
export function BlastRadius({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const hit = atRiskFrom(catalog, entity.id);
  if (!hit.length) return null;
  const row = ({ entity: e, cause }: (typeof hit)[number]) => (
    <li key={e.id}>
      <span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{name(e)}</Link>
      <span className="muted small">
        {" · "}{cause.depth === 1 ? "direct" : `${cause.depth} hops`}
        {cause.partial && " · partly affected"}
      </span>
    </li>
  );
  return (
    <section>
      <h2>Puts {hit.length} object{hit.length === 1 ? "" : "s"} at risk</h2>
      <p className="muted small">Objects that depend on this one and may be missing data or failing until it is fixed.</p>
      <ul className="plain-list">{hit.slice(0, 10).map(row)}</ul>
      {hit.length > 10 && (
        <details>
          <summary className="small">{hit.length - 10} more</summary>
          <ul className="plain-list">{hit.slice(10).map(row)}</ul>
        </details>
      )}
    </section>
  );
}
