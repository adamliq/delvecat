/**
 * Acknowledged and snoozed health findings.
 *
 * In the Splunk app they are kept in the app's own KV store collection
 * `delvecat_acks` (readable by everyone who can use the app, writable by catalog
 * publishers and admins), so a team shares them. Elsewhere (the demo, a catalog
 * opened from files) they are kept in this browser only.
 *
 * A finding counts as handled when it is accepted, or snoozed until a date that has
 * not passed, and it has not got worse since (a warning that turns critical shows
 * again).
 */
import { APP, IN_SPLUNK, splunkdUrl } from "./splunkSource";
import { canBuild, currentUser, formKey } from "./splunkBuild";

export const ACK_COLLECTION = "delvecat_acks";
const LOCAL = "delvecat.health.acks";

export type AckState = "accepted" | "snoozed";

export interface Ack {
  _key: string;
  entity: string;
  check: string;
  state: AckState;
  /** Snoozed until (ISO date-time). */
  until?: string;
  /** Status when acknowledged: if the finding gets worse, it shows again. */
  status: "warning" | "critical";
  note?: string;
  by?: string;
  at: string;
}

export interface AckStore {
  /** Where acknowledgements are kept, in words. */
  where: string;
  list(): Promise<Ack[]>;
  /** Whether this viewer may change them (false: read only). */
  canWrite(): Promise<boolean>;
  save(ack: Omit<Ack, "_key" | "at" | "by">): Promise<Ack>;
  remove(key: string): Promise<void>;
}

/** A stable key for a finding (KV keys should stay short and URL-safe). */
export function ackKey(entity: string, check: string): string {
  // Two FNV-1a 32-bit hashes with different offsets: 64 bits, plenty for a catalog.
  const fnv = (s: string, h: number) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const text = `${entity}\u0000${check}`;
  return `ack-${fnv(text, 0x811c9dc5)}${fnv(text, 0x050c5d1f)}`;
}

const RANK = { warning: 1, critical: 2 } as const;

/** Whether the finding is currently handled by this acknowledgement. */
export function isHandled(ack: Ack | undefined, status: "warning" | "critical", now: Date = new Date()): boolean {
  if (!ack) return false;
  if (RANK[status] > RANK[ack.status]) return false; // got worse since
  if (ack.state === "accepted") return true;
  return !!ack.until && new Date(ack.until).getTime() > now.getTime();
}

/** "Accepted by alice", "Snoozed until 3 Dec", "Snooze ended 1 Dec". */
export function ackLabel(ack: Ack, now: Date = new Date()): string {
  const by = ack.by ? ` by ${ack.by}` : "";
  if (ack.state === "accepted") return `Accepted${by}`;
  const until = ack.until ? new Date(ack.until) : null;
  const day = until?.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) ?? "";
  return until && until.getTime() > now.getTime() ? `Snoozed until ${day}${by}` : `Snooze ended ${day}`;
}

// --- this browser ----------------------------------------------------------------------

const memory = new Map<string, string>();

function readLocal(): Ack[] {
  let raw: string | null | undefined;
  try {
    raw = globalThis.localStorage?.getItem(LOCAL);
  } catch {
    raw = undefined;
  }
  try {
    const v = JSON.parse(raw ?? memory.get(LOCAL) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLocal(acks: Ack[]): void {
  const text = JSON.stringify(acks);
  memory.set(LOCAL, text);
  try {
    globalThis.localStorage?.setItem(LOCAL, text);
  } catch {
    // storage blocked: kept for this page session
  }
}

export const browserStore: AckStore = {
  where: "in this browser only",
  list: async () => readLocal(),
  canWrite: async () => true,
  async save(a) {
    const ack: Ack = { ...a, _key: ackKey(a.entity, a.check), at: new Date().toISOString() };
    writeLocal([...readLocal().filter((x) => x._key !== ack._key), ack]);
    return ack;
  },
  async remove(key) {
    writeLocal(readLocal().filter((x) => x._key !== key));
  },
};

// --- the Splunk app ----------------------------------------------------------------------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const ackPath = (rest = "") => `/servicesNS/nobody/${APP}/storage/collections/data/${ACK_COLLECTION}${rest}`;

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { "X-Requested-With": "XMLHttpRequest" };
  if (json) h["Content-Type"] = "application/json";
  const key = formKey();
  if (key) h["X-Splunk-Form-Key"] = key;
  return h;
}

export function splunkStore(fetchFn: Fetch = (u, i) => fetch(u, i)): AckStore {
  let user: Promise<string> | undefined;
  return {
    where: "in the DelveCat app, for everyone who uses it",
    async list() {
      const resp = await fetchFn(splunkdUrl(`${ackPath()}?output_mode=json`), { credentials: "same-origin", cache: "no-store" });
      if (resp.status === 404 || resp.status === 403) return []; // collection missing or not readable
      if (!resp.ok) throw new Error(`Could not read acknowledgements (HTTP ${resp.status})`);
      return (await resp.json()) as Ack[];
    },
    canWrite: () => canBuild(fetchFn),
    async save(a) {
      user ??= currentUser(fetchFn).catch(() => "");
      const ack: Ack = { ...a, _key: ackKey(a.entity, a.check), at: new Date().toISOString(), by: (await user) || undefined };
      const resp = await fetchFn(splunkdUrl(`${ackPath("/batch_save")}?output_mode=json`), {
        method: "POST",
        credentials: "same-origin",
        headers: headers(true),
        body: JSON.stringify([ack]),
      });
      if (resp.status === 401 || resp.status === 403) {
        throw new Error("Only catalog publishers (the delvecat_publisher role) and admins can acknowledge findings.");
      }
      if (!resp.ok) throw new Error(`Could not save (HTTP ${resp.status})`);
      return ack;
    },
    async remove(key) {
      const resp = await fetchFn(splunkdUrl(`${ackPath(`/${encodeURIComponent(key)}`)}?output_mode=json`), {
        method: "DELETE",
        credentials: "same-origin",
        headers: headers(false),
      });
      if (!resp.ok && resp.status !== 404) throw new Error(`Could not remove (HTTP ${resp.status})`);
    },
  };
}

export const ackStore = (): AckStore => (IN_SPLUNK ? splunkStore() : browserStore);
