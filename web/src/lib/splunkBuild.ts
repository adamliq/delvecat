/**
 * Building the catalog from the Splunk app's Build page: dispatches `| delvecatbuild` as a
 * search job with the viewer's session and follows it through the "build" status
 * document the command keeps in the app's collection.
 */
import { APP, COLLECTION, splunkdUrl } from "./splunkSource";

export interface BuildOptions {
  fields: boolean;
  usage: boolean;
  redact: "none" | "internal";
  instance: string;
  instanceName: string;
  webUrl?: string;
  /** Publish even if much smaller than the current catalog. */
  replaceSmaller?: boolean;
}

export interface BuildStatus {
  state: "running" | "done" | "failed";
  sid: string;
  user: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  step: string;
  message?: string;
  /** "smaller": built but not published, being much smaller than the current catalog. */
  reason?: "smaller" | "error";
  previousEntities?: number;
  dryRun?: boolean;
  entities?: number;
  edges?: number;
  instance?: string;
  options?: Partial<BuildOptions>;
  problems?: { connector: string; status: string; message: string }[];
}

export interface JobState {
  dispatchState: string;
  isDone: boolean;
  isFailed: boolean;
  messages: string[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (u, i) => fetch(u, i);

/** Splunk Web wants its CSRF token (a cookie) back in a header on every POST. */
export function formKey(cookie: string = globalThis.document?.cookie ?? ""): string | null {
  const m = /(?:^|;\s*)splunkweb_csrf_token_\d+=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Quote a value for SPL: double quotes, with backslashes and quotes escaped. */
export function splQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSearch(o: BuildOptions): string {
  const args = [`fields=${o.fields}`, `usage=${o.usage}`, `redact=${o.redact}`];
  if (o.instance.trim()) args.push(`instance=${splQuote(o.instance.trim())}`);
  if (o.instanceName.trim()) args.push(`instancename=${splQuote(o.instanceName.trim())}`);
  if (o.webUrl) args.push(`weburl=${splQuote(o.webUrl)}`);
  if (o.replaceSmaller) args.push("replacesmaller=true");
  return `| delvecatbuild ${args.join(" ")}`;
}

async function getJson<T>(path: string, fetchFn: Fetch): Promise<T | null> {
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetchFn(splunkdUrl(`${path}${sep}output_mode=json`), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Splunk answered HTTP ${resp.status} for ${path}`);
  return (await resp.json()) as T;
}

async function post(path: string, body: Record<string, string>, fetchFn: Fetch): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
  };
  const key = formKey();
  if (key) headers["X-Splunk-Form-Key"] = key;
  return fetchFn(splunkdUrl(path), {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: new URLSearchParams({ ...body, output_mode: "json" }).toString(),
  });
}

/** Whether the viewer may build: the command is visible only to delvecat_publisher and admins. */
export async function canBuild(fetchFn: Fetch = defaultFetch): Promise<boolean> {
  try {
    return !!(await getJson(`/servicesNS/-/${APP}/configs/conf-commands/delvecatbuild`, fetchFn));
  } catch {
    return false;
  }
}

export async function currentUser(fetchFn: Fetch = defaultFetch): Promise<string> {
  const ctx = await getJson<{ entry: { content: { username: string } }[] }>(
    "/services/authentication/current-context",
    fetchFn,
  );
  return ctx?.entry[0]?.content.username ?? "nobody";
}

export async function readBuildStatus(fetchFn: Fetch = defaultFetch): Promise<BuildStatus | null> {
  return getJson<BuildStatus>(`/servicesNS/nobody/${APP}/storage/collections/data/${COLLECTION}/build`, fetchFn);
}

/** Start a build; returns the search id. */
export async function startBuild(o: BuildOptions, fetchFn: Fetch = defaultFetch): Promise<string> {
  const user = await currentUser(fetchFn);
  const resp = await post(
    `/servicesNS/${encodeURIComponent(user)}/${APP}/search/jobs`,
    { search: buildSearch(o), exec_mode: "normal", earliest_time: "-1m", latest_time: "now" },
    fetchFn,
  );
  const body = (await resp.json().catch(() => ({}))) as { sid?: string; messages?: { text: string }[] };
  if (!resp.ok || !body.sid) {
    throw new Error(body.messages?.map((m) => m.text).join("; ") || `Could not start the build (HTTP ${resp.status}).`);
  }
  return body.sid;
}

export async function jobState(sid: string, fetchFn: Fetch = defaultFetch): Promise<JobState | null> {
  type Job = {
    entry: {
      content: {
        dispatchState: string;
        isDone: boolean;
        isFailed: boolean;
        messages?: { type: string; text: string }[];
      };
    }[];
  };
  const job = await getJson<Job>(`/services/search/jobs/${encodeURIComponent(sid)}`, fetchFn);
  const c = job?.entry[0]?.content;
  if (!c) return null;
  const messages = (c.messages ?? []).filter((m) => /^(fatal|error)$/i.test(m.type)).map((m) => m.text);
  return { dispatchState: c.dispatchState, isDone: !!c.isDone, isFailed: !!c.isFailed, messages };
}

export async function cancelBuild(sid: string, fetchFn: Fetch = defaultFetch): Promise<void> {
  await post(`/services/search/jobs/${encodeURIComponent(sid)}/control`, { action: "cancel" }, fetchFn);
}
