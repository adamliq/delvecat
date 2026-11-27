/**
 * The published catalog, kept in this browser (IndexedDB) so that opening the app again
 * neither downloads it from Splunk nor decompresses it again: kept as text (about 210 MB
 * at 300,000 objects), or as the compressed bytes (about 26 MB) where the browser will
 * not store that much. One copy is kept, keyed by the catalog's generation and checksum:
 * a new build replaces it. The pointer
 * is always read from Splunk first, so the copy is only used while it is still the
 * published catalog and the viewer may still read it.
 *
 * Every call is best effort: private windows, blocked storage or a full disk only mean
 * no copy is kept.
 */
const DB = "delvecat";
const STORE = "catalog";
const KEY = "published";

export interface CachedCatalog {
  generation: string;
  sha256: string;
  /** The catalog's JSON text, or (when that could not be stored) its gzip bytes. */
  text?: string;
  bytes?: Uint8Array<ArrayBuffer>;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function done<T>(req: IDBRequest<T> | null, tx: IDBTransaction): Promise<T | undefined> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}

/** The kept copy when it is this generation (and checksum), else null. */
export async function readCachedCatalog(generation: string, sha256: string): Promise<{ text?: string; bytes?: Uint8Array<ArrayBuffer> } | null> {
  const db = await open();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, "readonly");
    const hit = (await done(tx.objectStore(STORE).get(KEY), tx)) as CachedCatalog | undefined;
    if (!hit || hit.generation !== generation || hit.sha256 !== sha256) return null;
    return hit.text ? { text: hit.text } : hit.bytes ? { bytes: hit.bytes } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Keep this copy, replacing any other: as text when given, else (or when the text is
 * refused, e.g. over the browser's quota) as bytes. */
export async function writeCachedCatalog(entry: CachedCatalog): Promise<void> {
  const db = await open();
  if (!db) return;
  const put = (value: CachedCatalog) =>
    new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false); // e.g. over the quota
        tx.onabort = () => resolve(false);
        tx.objectStore(STORE).put(value, KEY);
      } catch {
        resolve(false);
      }
    });
  try {
    const { text, bytes, ...key } = entry;
    if (text !== undefined && (await put({ ...key, text }))) return;
    if (bytes) await put({ ...key, bytes });
  } finally {
    db.close();
  }
}

/** Remove the kept copy (no catalog published, or access lost). */
export async function clearCachedCatalog(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    await done(null, tx);
  } catch {
    /* nothing kept */
  } finally {
    db.close();
  }
}
