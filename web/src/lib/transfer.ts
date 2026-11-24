/**
 * Moving a catalog between stacks: download this stack's catalog as a file, or import
 * one (a file, or read straight from another stack) into this stack's app. Imports run
 * in the app's endpoint on this Splunk; the other stack is only read, and its token is
 * sent once and not stored.
 */
import type { CatalogBundle } from "../generated/catalog";
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
  const stream = new Blob([JSON.stringify(whole)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
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

export async function importCatalog(
  body: { source: "file"; data: string; filename?: string; mode: ImportMode } | { source: "stack"; url: string; token: string; verify: boolean; mode: ImportMode },
  fetchFn: Fetch = (u, i) => fetch(u, i),
): Promise<ImportSummary> {
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
  if (!resp.ok) throw new Error((data as { error?: string })?.error ?? `The import failed (HTTP ${resp.status}).`);
  return data as ImportSummary;
}
