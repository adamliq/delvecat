/**
 * Loading the catalog inside the DelveCat Splunk app.
 *
 * `delvecat-ingest publish` stores the catalog in the app's KV store collection as
 * gzip-compressed JSON, base64-encoded and split into parts, plus a pointer document
 * ("current") naming the generation, the number of parts and the sha256 of the
 * compressed bytes. The page reads them through Splunk Web's splunkd proxy with the
 * viewer's own session, so the collection's permissions decide who can see it.
 */
import type { CatalogBundle } from "../generated/catalog";
import { BundleError, parseBundle } from "./catalog";

export const IN_SPLUNK = import.meta.env.MODE === "splunk";

export const APP = "delvecat";

/**
 * Where the app's static files are. In the Splunk app the page URL is the view's, not the
 * build folder's, so static files are found relative to this module (in delvecat.js, at
 * the root of the build folder). Elsewhere, Vite's relative base.
 */
export function staticBase(): string {
  if (!IN_SPLUNK) return import.meta.env.BASE_URL;
  const here = import.meta.url; // not inlined: Vite rewrites new URL("...", import.meta.url)
  return new URL("./", here).href;
}
export const COLLECTION = "delvecat_catalog";

export interface Pointer {
  publishedBy?: string;
  generation: string;
  parts: number;
  sha256: string;
  bytes: number;
  encoding: string;
  publishedAt?: string;
}

/**
 * Splunk Web's proxy to splunkd: `<root>/<locale>/splunkd/__raw<path>`, where the page is
 * `<root>/<locale>/app/<app>/<view>` (root is empty unless Splunk Web has a root_endpoint).
 */
export function splunkdUrl(path: string, loc: Pick<Location, "pathname"> = globalThis.location ?? { pathname: "" }): string {
  return `${splunkWebPrefix(loc)}/splunkd/__raw${path}`;
}

/** Splunk's home page (the app launcher), for the way back from DelveCat. */
export function splunkHomeUrl(loc: Pick<Location, "pathname"> = globalThis.location ?? { pathname: "" }): string {
  return `${splunkWebPrefix(loc)}/app/launcher/home`;
}

function splunkWebPrefix(loc: Pick<Location, "pathname">): string {
  const m = /^(.*?)\/([^/]+)\/app\/[^/]+(\/|$)/.exec(loc.pathname);
  return m ? `${m[1]}/${m[2]}` : "/en-US";
}

const dataPath = (key: string) =>
  `/servicesNS/nobody/${APP}/storage/collections/data/${COLLECTION}/${encodeURIComponent(key)}?output_mode=json`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getDoc<T>(key: string, fetchFn: Fetch): Promise<T | null> {
  const resp = await fetchFn(splunkdUrl(dataPath(key)), { credentials: "same-origin", cache: "no-store" });
  if (resp.status === 404) return null;
  if (resp.status === 401 || resp.status === 403) {
    throw new BundleError(
      "You do not have access to the DelveCat catalog. Ask a Splunk admin for the delvecat_user role.",
    );
  }
  if (!resp.ok) throw new BundleError(`Could not read the catalog from Splunk (HTTP ${resp.status}).`);
  return (await resp.json()) as T;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

class StaleGeneration extends Error {}

async function readGeneration(pointer: Pointer, fetchFn: Fetch): Promise<CatalogBundle> {
  if (pointer.encoding !== "gzip+base64") {
    throw new BundleError(`Unsupported catalog encoding ${pointer.encoding}. Update the DelveCat app.`);
  }
  const parts = await Promise.all(
    Array.from({ length: pointer.parts }, (_, n) =>
      getDoc<{ data: string }>(`${pointer.generation}-${n}`, fetchFn),
    ),
  );
  // A part removed under us means a newer catalog was published meanwhile.
  if (parts.some((p) => !p)) throw new StaleGeneration();
  const bytes = base64ToBytes(parts.map((p) => p!.data).join(""));
  const hash = await sha256Hex(bytes);
  if (hash && hash !== pointer.sha256) throw new BundleError("The published catalog is corrupt (sha256 mismatch).");
  return parseBundle(await gunzip(bytes));
}

/** The published catalog's pointer document (who published it, and when), or null. */
export async function readPointer(fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<Pointer | null> {
  return getDoc<Pointer>("current", fetchFn);
}

/** The catalog published to this Splunk, or null if none has been published yet. */
export async function fetchSplunkCatalog(
  fetchFn: Fetch = (u, i) => fetch(u, i),
): Promise<{ bundle: CatalogBundle; pointer: Pointer } | null> {
  for (let attempt = 0; ; attempt++) {
    const pointer = await getDoc<Pointer>("current", fetchFn);
    if (!pointer) return null;
    try {
      return { bundle: await readGeneration(pointer, fetchFn), pointer };
    } catch (err) {
      if (!(err instanceof StaleGeneration) || attempt >= 2) {
        if (err instanceof StaleGeneration) throw new BundleError("The catalog changed while loading. Reload the page.");
        throw err;
      }
    }
  }
}
