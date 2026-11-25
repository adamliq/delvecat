import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Catalog } from "../lib/catalog";
import type { Entity } from "../generated/catalog";
import { entityPath, searchPath } from "../lib/routes";
import { instName, passedOnTo, tierFacts } from "../lib/tiers";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** On deployment clients and apps: how they sit in a tiered deployment server setup. */
export function TierPanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const p = (entity.properties ?? {}) as Record<string, unknown>;
  const lines: ReactNode[] = [];
  if (entity.type === "deploymentClient") {
    const ds = str(p.deploymentServerInstance);
    if (ds) {
      const t = tierFacts(catalog.bundle.instances.find((i) => i.id === ds));
      lines.push(
        <>This client is the deployment server <Link to={searchPath({ instance: ds })}>{instName(catalog, ds)}</Link>
          {t?.tier ? <> (tier {t.tier})</> : null}. {t?.relaysApps === false
            ? "It installs the apps it gets here itself; it does not pass them on."
            : <>It passes the apps it gets here on to <Link to={searchPath({ instance: ds, type: "deploymentClient" })}>its own clients</Link>.</>}</>,
      );
    }
    const moved = str(p.movedTo);
    if (moved) {
      lines.push(<>Moved to the deployment server <Link to={searchPath({ instance: moved, type: "deploymentClient" })}>{instName(catalog, moved)}</Link>, which it now phones home to; this record is from before.</>);
    }
  }
  if (entity.type === "deploymentApp") {
    const from = str(p.receivedFrom);
    const up = from ? catalog.byId.get(from) : undefined;
    if (from) {
      lines.push(<>Received from <Link to={entityPath(from)}>{up?.name ?? from}</Link> on the upstream deployment server {instName(catalog, up?.instance ?? from.split(":")[0])}: change it there, as changes made here are replaced at the next phone home.</>);
    } else if (p.origin === "local") {
      lines.push(<>Managed on this deployment server only: it does not come from the upstream deployment server.</>);
    }
    const down = passedOnTo(catalog, entity);
    if (down.length) {
      lines.push(<>Passed on through {down.length === 1 ? "the deployment server" : "the deployment servers"}{" "}
        {down.map((d, i) => <span key={d.id}>{i ? ", " : ""}<Link to={entityPath(d.id)}>{instName(catalog, d.instance)}</Link></span>)}.</>);
    }
  }
  if (!lines.length) return null;
  return (
    <section className="tier-panel" aria-label="Deployment tiers">
      {lines.map((l, i) => <p key={i} className="small">{l}</p>)}
    </section>
  );
}
