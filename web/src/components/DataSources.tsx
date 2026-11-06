import { Link } from "react-router-dom";
import type { Entity, EntityType } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { typeLabel } from "../lib/labels";
import { upstreamOf } from "../lib/lineage";
import { entityPath } from "../lib/routes";

const GROUPS: { title: string; types: EntityType[]; hint: string }[] = [
  { title: "Forwarders and machines", types: ["forwarder", "deploymentClient", "streamForwarder"],
    hint: "Machines whose data carries a host value sent to this data" },
  { title: "Databases", types: ["externalTable", "dbConnection", "dbInput"], hint: "DB Connect inputs and the tables they read" },
  { title: "Network streams", types: ["streamDefinition", "streamGroup"], hint: "Splunk Stream protocols captured into this data" },
  { title: "Deployment", types: ["serverClass", "deploymentApp"], hint: "Deployment Server classes and apps that configure the inputs" },
  { title: "Inputs", types: ["input"], hint: "Monitor, network, scripted and HEC inputs" },
];

/** "Where does this data come from?" for indexes and sourcetypes. */
export function DataSources({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const up = upstreamOf(catalog, entity.id, 8);
  const groups = GROUPS.map((g) => ({
    ...g,
    items: up.filter((e) => g.types.includes(e.type)).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <section>
      <h2>Where this data comes from</h2>
      <div className="rel-grid">
        {groups.map((g) => (
          <div key={g.title} className="rel-group">
            <h3 title={g.hint}>{g.title} <span className="muted">({g.items.length})</span></h3>
            <ul className="plain-list">
              {g.items.slice(0, 15).map((e) => (
                <li key={e.id}>
                  <span className="muted rel-type">{typeLabel(e.type)}</span>{" "}
                  <Link to={`${entityPath(e.id)}?tab=lineage`}>{e.displayName ?? e.name}</Link>
                  {e.disabled && <span className="muted small"> (disabled)</span>}
                </li>
              ))}
              {g.items.length > 15 && <li className="muted small">…and {g.items.length - 15} more</li>}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
