import { APP, splunkdUrl } from "./splunkSource";
import { formKey } from "./splunkBuild";

/** The scheduled report the app ships (disabled) for building on a schedule. */
export const SCHEDULE_NAME = "Licoryx Delvecat - scheduled build";
const path = () => `/servicesNS/nobody/${APP}/saved/searches/${encodeURIComponent(SCHEDULE_NAME)}`;

export type Frequency = "daily" | "weekly" | "custom";
export interface Schedule {
  enabled: boolean;
  cron: string;
  search: string;
  nextRun?: string;
  /** Whether the viewer may change it. */
  canWrite: boolean;
}
export interface When {
  frequency: Frequency;
  hour: number;
  minute: number;
  day: number; // 0 Sunday .. 6 Saturday
  cron: string; // as given, for custom
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The cron expression of a daily or weekly time (Splunk's clock), or a custom one as given. */
export function toCron(w: When): string {
  if (w.frequency === "custom") return w.cron.trim();
  const m = Math.min(59, Math.max(0, Math.round(w.minute)));
  const h = Math.min(23, Math.max(0, Math.round(w.hour)));
  return w.frequency === "weekly" ? `${m} ${h} * * ${w.day}` : `${m} ${h} * * *`;
}

/** Read a cron expression back as daily or weekly where it is one; custom otherwise. */
export function fromCron(cron: string): When {
  const base: When = { frequency: "custom", hour: 2, minute: 17, day: 1, cron };
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(cron.trim());
  if (!m) return base;
  const [minute, hour] = [Number(m[1]), Number(m[2])];
  if (minute > 59 || hour > 23) return base;
  return m[3] === "*" ? { ...base, frequency: "daily", hour, minute } : { ...base, frequency: "weekly", hour, minute, day: Number(m[3]) };
}

export function describe(cron: string): string {
  const w = fromCron(cron);
  const t = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  return w.frequency === "daily" ? `every day at ${t}` : w.frequency === "weekly" ? `every ${DAYS[w.day]} at ${t}` : `on the schedule ${cron}`;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function readSchedule(fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<Schedule | null> {
  const resp = await fetchFn(splunkdUrl(`${path()}?output_mode=json`), { credentials: "same-origin", cache: "no-store" });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Could not read the schedule (HTTP ${resp.status})`);
  type Body = { entry: { content: Record<string, unknown>; acl?: { can_write?: boolean } }[] };
  const e = ((await resp.json()) as Body).entry[0];
  const c = e.content;
  const on = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
  return {
    enabled: !on(c.disabled) && on(c.is_scheduled),
    cron: String(c.cron_schedule ?? ""),
    search: String(c.search ?? ""),
    nextRun: typeof c.next_scheduled_time === "string" && c.next_scheduled_time ? c.next_scheduled_time : undefined,
    canWrite: e.acl?.can_write !== false,
  };
}

/** Turn the schedule on (with this search and cron) or off. Only the app's own report. */
export async function saveSchedule(s: { enabled: boolean; cron: string; search: string }, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" };
  const key = formKey();
  if (key) headers["X-Splunk-Form-Key"] = key;
  const body = new URLSearchParams({
    output_mode: "json",
    search: s.search,
    cron_schedule: s.cron,
    is_scheduled: "1",
    disabled: s.enabled ? "0" : "1",
  });
  const resp = await fetchFn(splunkdUrl(path()), { method: "POST", credentials: "same-origin", headers, body: body.toString() });
  if (resp.status === 401 || resp.status === 403) throw new Error("Only catalog publishers (delvecat_publisher) and admins can schedule builds.");
  if (!resp.ok) {
    const msg = await resp.json().then((b: { messages?: { text: string }[] }) => b.messages?.map((m) => m.text).join("; ")).catch(() => "");
    throw new Error(msg || `Could not save the schedule (HTTP ${resp.status})`);
  }
}
