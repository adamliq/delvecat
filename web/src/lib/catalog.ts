import type { CatalogBundle, Edge, Entity, EntityType, Product } from "../generated/catalog";

export class BundleError extends Error {}

/** Light structural check; full validation happens in delvecat-ingest. */
export function parseBundle(text: string): CatalogBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BundleError("File is not valid JSON.");
  }
  const b = data as Partial<CatalogBundle>;
  if (!b || typeof b !== "object" || typeof b.schemaVersion !== "string") {
    throw new BundleError("Not a DelveCat bundle (missing schemaVersion).");
  }
  if (!b.schemaVersion.startsWith("0.1.")) {
    throw new BundleError(`Unsupported schema version ${b.schemaVersion}.`);
  }
  if (!Array.isArray(b.entities) || !Array.isArray(b.edges) || !Array.isArray(b.instances)) {
    throw new BundleError("Bundle is missing entities, edges or instances.");
  }
  return b as CatalogBundle;
}

export class Catalog {
  readonly byId = new Map<string, Entity>();
  private readonly outgoing = new Map<string, Edge[]>();
  private readonly incoming = new Map<string, Edge[]>();

  constructor(readonly bundle: CatalogBundle) {
    for (const e of bundle.entities) this.byId.set(e.id, e);
    for (const edge of bundle.edges) {
      push(this.outgoing, edge.from, edge);
      push(this.incoming, edge.to, edge);
    }
  }

  get entities(): Entity[] {
    return this.bundle.entities;
  }

  edgesFrom(id: string): Edge[] {
    return this.outgoing.get(id) ?? [];
  }

  edgesTo(id: string): Edge[] {
    return this.incoming.get(id) ?? [];
  }

  countBy<K extends "type" | "product">(key: K): Map<K extends "type" ? EntityType : Product, number> {
    const counts = new Map();
    for (const e of this.bundle.entities) counts.set(e[key], (counts.get(e[key]) ?? 0) + 1);
    return counts;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Where the default bundle lives: `?bundle=<url>` overrides `./catalog.json`. */
export function defaultBundleUrl(location: Pick<Location, "search"> = window.location): string {
  return new URLSearchParams(location.search).get("bundle") ?? `${import.meta.env.BASE_URL}catalog.json`;
}

export async function fetchBundle(url: string): Promise<CatalogBundle> {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new BundleError(`Could not load ${url} (HTTP ${resp.status}).`);
  return parseBundle(await resp.text());
}
