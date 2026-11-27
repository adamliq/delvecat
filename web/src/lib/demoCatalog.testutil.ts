/** Tests: the demo catalog (public/catalog, built by `make demo`) with its shards read in. */
import { readFileSync } from "node:fs";
import type { CatalogBundle } from "../generated/catalog";
import { expandBundle, expandEdges, type EdgeTable } from "./catalog";

export function demoBundle(dir = new URL("../../public/catalog/", import.meta.url)): CatalogBundle {
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, dir), "utf8"));
  const m = read("catalog.json") as CatalogBundle & { shards?: { path: string; kind: string }[] };
  const entities = [...m.entities];
  const edges = [...m.edges];
  for (const sh of m.shards ?? []) {
    const body = read(sh.path);
    if (body.edgeTable) expandEdges(body.edgeTable as EdgeTable, edges);
    else for (const x of body[sh.kind]) (sh.kind === "entities" ? entities : edges).push(x);
  }
  const { shards: _s, ...rest } = m;
  void _s;
  return expandBundle({ ...rest, entities, edges });
}
