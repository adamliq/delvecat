/**
 * The Testing page's connection test: the app's endpoint on this Splunk connects to
 * the other stack (a browser cannot reach another stack's management port), runs
 * read-only checks and reports each step. The token goes in the request body once;
 * it is not stored here or there. Recently tested addresses (never tokens) are kept
 * in this browser.
 */
import { formKey } from "./splunkBuild";
import { splunkdUrl } from "./splunkSource";

export interface StepResult {
  step: string;
  title: string;
  status: "ok" | "warning" | "failed" | "skipped";
  message: string;
  ms?: number;
  version?: string;
  generatedAt?: string;
  entities?: number;
  remote?: { serverName?: string; version?: string; product?: string };
}

export interface ConnectivityResult {
  target: string;
  ok: boolean;
  checkedAt?: string;
  steps: StepResult[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function testConnection(
  body: { url: string; token?: string; verify: boolean; timeout?: number },
  fetchFn: Fetch = (u, i) => fetch(u, i),
): Promise<ConnectivityResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  const key = formKey();
  if (key) headers["X-Splunk-Form-Key"] = key;
  const resp = await fetchFn(splunkdUrl("/services/delvecat/connectivity?output_mode=json"), {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    // not JSON: an error page
  }
  if (resp.status === 403) throw new Error((data as { error?: string })?.error ?? "Only catalog publishers and admins can test connections.");
  if (resp.status === 404) throw new Error("The test endpoint is not available: update the app on this Splunk (0.21.0 or later), then restart Splunk.");
  if (!resp.ok) throw new Error((data as { error?: string })?.error ?? `The test failed to run (HTTP ${resp.status}).`);
  return data as ConnectivityResult;
}

// --- recent addresses, in this browser ------------------------------------------------

const RECENT = "delvecat.testing.recent";
const memory: string[] = [];

export function recentTargets(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(RECENT) ?? "null");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [...memory];
  } catch {
    return [...memory];
  }
}

export function rememberTarget(url: string): string[] {
  const list = [url, ...recentTargets().filter((x) => x !== url)].slice(0, 8);
  memory.splice(0, memory.length, ...list);
  try {
    globalThis.localStorage?.setItem(RECENT, JSON.stringify(list));
  } catch {
    // storage blocked: kept for this page session
  }
  return list;
}
