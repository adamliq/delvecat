/**
 * Moving a catalog between stacks: download this stack's catalog as a file, or import
 * one (a file, or read straight from another stack) into this stack's app. Imports run
 * in the app's endpoint on this Splunk; the other stack is only read, and its token is
 * sent once and not stored.
 */
import type { CatalogBundle } from "../generated/catalog";
import { compactEdges } from "./catalog";
import { formKey } from "./splunkBuild";
import { readPointer, splunkdUrl, type Pointer } from "./splunkSource";

export type ImportMode = "combine" | "replace";

export interface ImportSummary {
  mode: ImportMode;
  before: number;
  after: number;
  importedInstances: string[];
  replacedInstances?: string[];
  keptInstances?: string[];
  instances: { id: string; name: string }[];
  source: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const day = () => new Date().toISOString().slice(0, 10);

/** A file name that says what the catalog is: its instances and today's date. */
export function exportName(bundle: Pick<CatalogBundle, "instances">): string {
  const ids = bundle.instances.map((i) => i.id).join("+").replace(/[^A-Za-z0-9_+-]/g, "_").slice(0, 80) || "catalog";
  return `delvecat-${ids}-${day()}.json.gz`;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** gzip of the catalog as JSON (shards, if any, already joined into the bundle). */
export async function gzipBundle(bundle: CatalogBundle): Promise<Blob> {
  const { shards: _shards, ...whole } = bundle as CatalogBundle & { shards?: unknown };
  // Stored form: relationships as an edge table (much smaller on large catalogs).
  const stored = { ...whole, schemaVersion: "0.2.0", modelVersion: whole.schemaVersion, edges: [], edgeTable: compactEdges(whole.edges) };
  const stream = new Blob(jsonPieces(stored)).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** An object as JSON in pieces: large top-level lists a thousand items at a time, so no
 * single string holds the whole catalog (browsers cap a string at about 512 million
 * characters, which a merged catalog of several large stacks can exceed). */
export function jsonPieces(obj: Record<string, unknown>, chunk = 1000): string[] {
  const out: string[] = ["{"];
  Object.entries(obj).forEach(([k, v], i) => {
    if (v === undefined) return;
    out.push(`${i && out.length > 1 ? "," : ""}${JSON.stringify(k)}:`);
    if (Array.isArray(v) && v.length > chunk) {
      out.push("[");
      for (let j = 0; j < v.length; j += chunk) {
        out.push((j ? "," : "") + v.slice(j, j + chunk).map((x) => JSON.stringify(x) ?? "null").join(","));
      }
      out.push("]");
    } else {
      out.push(JSON.stringify(v));
    }
  });
  out.push("}");
  return out;
}

/** Download the catalog: in Splunk, the published bytes as stored (already gzipped). */
export async function exportCatalog(bundle: CatalogBundle, inSplunk: boolean, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<void> {
  if (inSplunk) {
    const pointer: Pointer | null = await readPointer(fetchFn);
    if (pointer?.encoding === "gzip+base64") {
      const parts = await Promise.all(Array.from({ length: pointer.parts }, async (_, n) => {
        const r = await fetchFn(splunkdUrl(`/servicesNS/nobody/delvecat/storage/collections/data/delvecat_catalog/${pointer.generation}-${n}?output_mode=json`), { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) throw new Error(`Could not read the catalog (HTTP ${r.status}).`);
        return ((await r.json()) as { data: string }).data;
      }));
      save(new Blob([base64ToBytes(parts.join(""))], { type: "application/gzip" }), exportName(bundle));
      return;
    }
  }
  save(await gzipBundle(bundle), exportName(bundle));
}

/** File bytes as base64, in chunks (large files overflow String.fromCharCode's arguments). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Stacks imported this long ago are flagged: they change only when imported again. */
export const STALE_IMPORT_DAYS = 7;

export function importAgeDays(at: string | undefined, now = Date.now()): number | undefined {
  const t = at ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? undefined : Math.floor((now - t) / 86400000);
}

/** Publish this stack's catalog without an imported stack. */
export async function removeImported(instance: string, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<{ removed: string; before: number; after: number }> {
  return post({ action: "remove", instance }, fetchFn) as Promise<{ removed: string; before: number; after: number }>;
}

async function post(body: unknown, fetchFn: Fetch): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  const key = formKey();
  if (key) headers["X-Splunk-Form-Key"] = key;
  const resp = await fetchFn(splunkdUrl("/services/delvecat/transfer?output_mode=json"), {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    // an error page
  }
  if (resp.status === 404) throw new Error("The import endpoint is not available: update the app on this Splunk (0.23.0 or later), then restart Splunk.");
  if (!resp.ok) throw new Error((data as { error?: string })?.error ?? `The request failed (HTTP ${resp.status}).`);
  return data;
}

export async function importCatalog(
  body: { source: "file"; data: string; filename?: string; mode: ImportMode } | { source: "stack"; url: string; token: string; verify: boolean; mode: ImportMode },
  fetchFn: Fetch = (u, i) => fetch(u, i),
): Promise<ImportSummary> {
  return post(body, fetchFn) as Promise<ImportSummary>;
}
