/**
 * SQL queries shared with everyone who uses the app, kept in the app's own KV store
 * collection `delvecat_queries` (readable by everyone who can use the app; catalog
 * publishers and admins share and remove them). A shared query runs in each viewer's
 * own browser, on the catalog they may read, read-only: sharing one changes nothing.
 * Outside the Splunk app there is nothing to share with, and only this browser's saved
 * queries show.
 */
import { APP, IN_SPLUNK, splunkdUrl } from "./splunkSource";
import { canBuild, currentUser, formKey } from "./splunkBuild";

export const QUERY_COLLECTION = "delvecat_queries";

export interface SharedQuery {
  _key: string;
  name: string;
  sql: string;
  by?: string;
  at: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A stable, URL-safe key for a query name (sharing a name again replaces it). */
export function queryKey(name: string): string {
  const fnv = (s: string, h: number) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const text = name.trim().toLowerCase();
  return `q-${fnv(text, 0x811c9dc5)}${fnv(text, 0x050c5d1f)}`;
}

const path = (rest = "") => `/servicesNS/nobody/${APP}/storage/collections/data/${QUERY_COLLECTION}${rest}`;

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { "X-Requested-With": "XMLHttpRequest" };
  if (json) h["Content-Type"] = "application/json";
  const key = formKey();
  if (key) h["X-Splunk-Form-Key"] = key;
  return h;
}

export interface SharedQueryStore {
  list(): Promise<SharedQuery[]>;
  canWrite(): Promise<boolean>;
  share(name: string, sql: string): Promise<SharedQuery>;
  remove(key: string): Promise<void>;
}

export function sharedQueryStore(fetchFn: Fetch = (u, i) => fetch(u, i)): SharedQueryStore {
  let user: Promise<string> | undefined;
  return {
    async list() {
      const resp = await fetchFn(splunkdUrl(`${path()}?output_mode=json`), { credentials: "same-origin", cache: "no-store" });
      if (resp.status === 404 || resp.status === 403) return []; // app not updated yet, or not readable
      if (!resp.ok) throw new Error(`Could not read the shared queries (HTTP ${resp.status})`);
      const rows = (await resp.json()) as SharedQuery[];
      return rows.filter((q) => q.name && q.sql).sort((a, b) => a.name.localeCompare(b.name));
    },
    canWrite: () => canBuild(fetchFn),
    async share(name, sql) {
      user ??= currentUser(fetchFn).catch(() => "");
      const q: SharedQuery = { _key: queryKey(name), name: name.trim(), sql: sql.trim(), at: new Date().toISOString(), by: (await user) || undefined };
      const resp = await fetchFn(splunkdUrl(`${path("/batch_save")}?output_mode=json`), {
        method: "POST",
        credentials: "same-origin",
        headers: headers(true),
        body: JSON.stringify([q]),
      });
      if (resp.status === 401 || resp.status === 403) throw new Error("Only catalog publishers (the delvecat_publisher role) and admins can share queries.");
      if (resp.status === 404) throw new Error("Sharing needs the app updated to 0.47.0 or later on this Splunk (then restart it).");
      if (!resp.ok) throw new Error(`Could not share (HTTP ${resp.status})`);
      return q;
    },
    async remove(key) {
      const resp = await fetchFn(splunkdUrl(`${path(`/${encodeURIComponent(key)}`)}?output_mode=json`), {
        method: "DELETE",
        credentials: "same-origin",
        headers: headers(false),
      });
      if (resp.status === 401 || resp.status === 403) throw new Error("Only catalog publishers and admins can remove shared queries.");
      if (!resp.ok && resp.status !== 404) throw new Error(`Could not remove (HTTP ${resp.status})`);
    },
  };
}

/** The shared query store in the Splunk app; none elsewhere. */
export const sharedQueries = (): SharedQueryStore | null => (IN_SPLUNK ? sharedQueryStore() : null);
