import type { CatalogBundle, Edge, Entity, EntityType, Product } from "../generated/catalog";

export class BundleError extends Error {}

/** Relationships as catalog files store them (schema 0.2): ids once, four numbers per edge. */
export interface EdgeTable {
  ids: string[];
  types: Edge["type"][];
  origins: string[];
  rows: number[];
}
type Stored = CatalogBundle & { edgeTable?: EdgeTable; modelVersion?: string };

/** Expand an edge table into edges, appended to ``out`` (a loop: millions of items). */
export function expandEdges(t: EdgeTable, out: Edge[] = []): Edge[] {
  if (t.rows.length % 4) throw new BundleError("The catalog's relationships are damaged (edgeTable).");
  for (let i = 0; i < t.rows.length; i += 4) {
    const o = t.rows[i + 3];
    const e: Edge = { from: t.ids[t.rows[i]], to: t.ids[t.rows[i + 1]], type: t.types[t.rows[i + 2]] };
    if (o >= 0) e.origin = t.origins[o] as Edge["origin"];
    out.push(e);
  }
  return out;
}

/** The compact stored form of edges (what Export writes). */
export function compactEdges(edges: Edge[]): EdgeTable {
  const ids = new Map<string, number>();
  const types = new Map<string, number>();
  const origins = new Map<string, number>();
  const at = (m: Map<string, number>, k: string) => {
    let i = m.get(k);
    if (i === undefined) m.set(k, (i = m.size));
    return i;
  };
  const rows: number[] = [];
  for (const e of edges) rows.push(at(ids, e.from), at(ids, e.to), at(types, e.type), e.origin ? at(origins, e.origin) : -1);
  return { ids: [...ids.keys()], types: [...types.keys()] as Edge["type"][], origins: [...origins.keys()], rows };
}

/** A stored catalog in its in-memory form: edgeTable expanded into edges (in place). */
export function expandBundle(b: CatalogBundle): CatalogBundle {
  const s = b as Stored;
  if (s.edgeTable) {
    s.edges = expandEdges(s.edgeTable, s.edges ?? []);
    delete s.edgeTable;
  }
  // A sharded manifest says 0.2 with its edges still in shard files: once read, it is 0.1.
  if (s.modelVersion || s.schemaVersion.startsWith("0.2.")) {
    s.schemaVersion = s.modelVersion ?? "0.1.2";
    delete s.modelVersion;
  }
  return s;
}

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
    throw new BundleError("Not a Licoryx Delvecat bundle (missing schemaVersion).");
  }
  if (!/^0\.[12]\.\d+$/.test(b.schemaVersion)) {
    throw new BundleError(`Unsupported schema version ${b.schemaVersion}. Update Licoryx Delvecat.`);
  }
  if (!Array.isArray(b.edges) && (b as Stored).edgeTable) (b as Stored).edges = [];
  if (!Array.isArray(b.entities) || !Array.isArray(b.edges) || !Array.isArray(b.instances)) {
    throw new BundleError("Bundle is missing entities, edges or instances.");
  }
  return expandBundle(b as CatalogBundle);
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

  private named?: Map<string, Entity[]>;
  private typed?: Map<string, Entity[]>;

  /** Objects of a type with this name on an instance (built once, on first use). */
  find(instance: string, type: string, name: string): Entity[] {
    if (!this.named) {
      this.named = new Map();
      for (const e of this.bundle.entities) push(this.named, `${e.instance}\u0000${e.type}\u0000${e.name}`, e);
    }
    return this.named.get(`${instance}\u0000${type}\u0000${name}`) ?? [];
  }

  /** The first object of a type with this name on an instance, if any. */
  findOne(instance: string, type: string, name: string): Entity | undefined {
    return this.find(instance, type, name)[0];
  }

  /** Every object of a type (built once, on first use). */
  ofType(type: string): Entity[] {
    if (!this.typed) {
      this.typed = new Map();
      for (const e of this.bundle.entities) push(this.typed, e.type, e);
    }
    return this.typed.get(type) ?? [];
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

/** Where the default bundle lives: `?bundle=<url>` overrides `./catalog/catalog.json`. */
export function defaultBundleUrl(location: Pick<Location, "search"> = window.location): string {
  return new URLSearchParams(location.search).get("bundle") ?? `${import.meta.env.BASE_URL}catalog/catalog.json`;
}

type Shard = NonNullable<CatalogBundle["shards"]>[number];

async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // not available outside secure contexts
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Inline a manifest's shards. `read` returns a shard's bytes given its relative path. */
export async function inlineShards(
  manifest: CatalogBundle,
  read: (shard: Shard) => Promise<ArrayBuffer>,
): Promise<CatalogBundle> {
  if (!manifest.shards?.length) return manifest;
  const entities = [...manifest.entities];
  const edges = [...manifest.edges];
  const parts = await Promise.all(
    manifest.shards.map(async (shard) => {
      const data = await read(shard);
      const hash = await sha256Hex(data);
      if (hash && hash !== shard.sha256) throw new BundleError(`Shard ${shard.path} is corrupt (sha256 mismatch).`);
      return { shard, body: JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown> };
    }),
  );
  for (const { shard, body } of parts) {
    if (shard.kind === "edges" && body.edgeTable) {
      expandEdges(body.edgeTable as EdgeTable, edges);
      continue;
    }
    const items = body[shard.kind];
    if (!Array.isArray(items)) throw new BundleError(`Shard ${shard.path} has no ${shard.kind} array.`);
    // A loop, not push(...items): spreading hundreds of thousands of items into one call
    // overflows the browser's stack ("Maximum call stack size exceeded").
    const target: unknown[] = shard.kind === "entities" ? entities : edges;
    for (const item of items) target.push(item);
  }
  const { shards: _omit, ...rest } = manifest;
  void _omit;
  return { ...rest, entities, edges };
}

export async function fetchBundle(url: string, onStage?: (stage: string) => void): Promise<CatalogBundle> {
  onStage?.("Downloading the catalog…");
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new BundleError(`Could not load ${url} (HTTP ${resp.status}).`);
  const manifest = parseBundle(await resp.text());
  if (manifest.shards?.length) onStage?.(`Downloading and reading ${manifest.shards.length} catalog files…`);
  const base = new URL(url, window.location.href);
  return inlineShards(manifest, async (shard) => {
    const r = await fetch(new URL(shard.path, base), { cache: "no-cache" });
    if (!r.ok) throw new BundleError(`Could not load shard ${shard.path} (HTTP ${r.status}).`);
    return r.arrayBuffer();
  });
}

/**
 * Open a bundle from local files (never uploaded). Accepts a single-file bundle, or a
 * sharded bundle selected as a folder / several files (matched by relative path or name).
 */
export async function openLocalFiles(files: File[]): Promise<{ bundle: CatalogBundle; label: string }> {
  if (!files.length) throw new BundleError("No file selected.");
  const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const manifestFile =
    files.find((f) => /(^|\/)catalog\.json$/.test(pathOf(f)) && !/\/entities\//.test(pathOf(f))) ??
    (files.length === 1 ? files[0] : undefined);
  if (!manifestFile) throw new BundleError("Select catalog.json (and its shard files), or the bundle folder.");
  const manifest = parseBundle(await manifestFile.text());
  const root = pathOf(manifestFile).replace(/catalog\.json$/, "");
  const bundle = await inlineShards(manifest, async (shard) => {
    const exact = files.find((f) => pathOf(f) === root + shard.path);
    const byName = files.filter((f) => f.name === shard.path.split("/").pop());
    const file = exact ?? (byName.length === 1 ? byName[0] : undefined);
    if (!file) throw new BundleError(`Missing shard file ${shard.path}. Open the whole bundle folder.`);
    return file.arrayBuffer();
  });
  return { bundle, label: `local ${manifest.shards?.length ? "folder" : "file"}: ${pathOf(manifestFile)}` };
}
