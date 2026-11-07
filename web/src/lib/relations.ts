import type { Edge, EdgeType, Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

const OUTGOING: Record<EdgeType, string> = {
  contains: "Contains",
  reads: "Reads",
  writes: "Writes to",
  uses: "Uses",
  feeds: "Feeds",
  deploys: "Deploys",
  triggers: "Triggers",
  accelerates: "Accelerates",
  mapsTo: "Applies to",
  grantsAccess: "Can search (incl. inherited)",
  memberOf: "Member of",
  inherits: "Inherits from",
  readsField: "Reads fields",
  definesField: "Defines fields",
};

const INCOMING: Record<EdgeType, string> = {
  contains: "Contained in",
  reads: "Read by",
  writes: "Written by",
  uses: "Used by",
  feeds: "Fed by",
  deploys: "Deployed by",
  triggers: "Triggered by",
  accelerates: "Accelerated by",
  mapsTo: "Tagged with",
  grantsAccess: "Searchable by roles",
  memberOf: "Members",
  inherits: "Inherited by",
  readsField: "Fields read by",
  definesField: "Defined by",
};

export interface RelationGroup {
  label: string;
  direction: "out" | "in";
  edgeType: EdgeType;
  entities: Entity[];
}

// Upstream context first (where it lives, what feeds it), then what it points at.
const ORDER: string[] = [
  "in:contains", "in:feeds", "in:writes", "out:uses", "out:reads", "out:feeds", "out:writes",
  "out:memberOf", "out:inherits", "out:grantsAccess", "in:grantsAccess", "in:memberOf",
  "in:inherits", "in:uses", "in:reads", "out:mapsTo", "in:mapsTo", "out:contains",
];

export function relationGroups(catalog: Catalog, id: string): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  const add = (edge: Edge, direction: "out" | "in") => {
    const other = catalog.byId.get(direction === "out" ? edge.to : edge.from);
    if (!other) return;
    const key = `${direction}:${edge.type}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: (direction === "out" ? OUTGOING : INCOMING)[edge.type],
        direction,
        edgeType: edge.type,
        entities: [],
      };
      groups.set(key, g);
    }
    g.entities.push(other);
  };
  catalog.edgesFrom(id).forEach((e) => add(e, "out"));
  catalog.edgesTo(id).forEach((e) => add(e, "in"));
  const rank = (k: string) => (ORDER.indexOf(k) === -1 ? ORDER.length : ORDER.indexOf(k));
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([, g]) => ({ ...g, entities: g.entities.sort((x, y) => x.name.localeCompare(y.name)) }));
}
