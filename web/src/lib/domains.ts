import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { flow } from "./lineage";

export type Domain = NonNullable<Catalog["bundle"]["domains"]>[number];
export type DataProduct = NonNullable<Catalog["bundle"]["dataProducts"]>[number];

export const domainOf = (e: Entity) => e.annotations?.domain;
export const productsOf = (e: Entity) => e.annotations?.dataProducts ?? [];

export function domains(catalog: Catalog): Domain[] {
  return catalog.bundle.domains ?? [];
}

export function dataProducts(catalog: Catalog): DataProduct[] {
  return catalog.bundle.dataProducts ?? [];
}

/** The domain and every sub-domain below it (cycle-safe). */
export function subtree(catalog: Catalog, name: string): Set<string> {
  const out = new Set<string>([name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of domains(catalog)) {
      if (d.parent && out.has(d.parent) && !out.has(d.name)) {
        out.add(d.name);
        grew = true;
      }
    }
  }
  return out;
}

export function domainAssets(catalog: Catalog, name: string, includeSub = true): Entity[] {
  const names = includeSub ? subtree(catalog, name) : new Set([name]);
  return catalog.entities.filter((e) => names.has(domainOf(e) ?? ""));
}

export function productAssets(catalog: Catalog, product: DataProduct): Entity[] {
  return product.assets.map((id) => catalog.byId.get(id)).filter((e): e is Entity => Boolean(e));
}

export interface Rollup {
  total: number;
  critical: number;
  warning: number;
  sensitive: number;
  unused: number;
  undocumented: number;
}

/** Health, sensitivity, cleanup and documentation counts for a set of assets. */
export function rollup(entities: Entity[]): Rollup {
  const r: Rollup = { total: entities.length, critical: 0, warning: 0, sensitive: 0, unused: 0, undocumented: 0 };
  for (const e of entities) {
    if (e.health?.status === "critical") r.critical++;
    if (e.health?.status === "warning") r.warning++;
    const gov = e.governance as { classifications?: { sensitive: boolean }[] } | undefined;
    if (gov?.classifications?.some((c) => c.sensitive)) r.sensitive++;
    if (e.usage?.unused && !e.usage.builtin) r.unused++;
    if (!e.annotations?.description && !e.description) r.undocumented++;
  }
  return r;
}

/** What a data product depends on (directly upstream, outside it) and who uses it
 * (directly downstream, outside it): its boundary. */
export function boundary(catalog: Catalog, product: DataProduct): { inputs: Entity[]; consumers: Entity[] } {
  const inside = new Set(product.assets);
  const f = flow(catalog);
  const inputs = new Set<string>();
  const consumers = new Set<string>();
  for (const id of inside) {
    for (const e of f.up.get(id) ?? []) if (!inside.has(e.from)) inputs.add(e.from);
    for (const e of f.down.get(id) ?? []) if (!inside.has(e.to)) consumers.add(e.to);
  }
  const resolve = (ids: Set<string>) =>
    [...ids].map((i) => catalog.byId.get(i)).filter((e): e is Entity => Boolean(e))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { inputs: resolve(inputs), consumers: resolve(consumers) };
}
