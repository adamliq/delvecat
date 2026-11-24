/**
 * Light, dark or automatic. Automatic follows the system; inside Splunk it follows the
 * user's Splunk theme (Settings > Preferences) when one is set. The choice is kept in
 * this browser.
 */
import { IN_SPLUNK, splunkdUrl } from "./splunkSource";

export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "delvecat.theme";

export function savedTheme(): ThemeChoice {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function apply(theme: "light" | "dark" | null) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** Splunk's theme for this user ("light" or "dark"), or null when it is not set or cannot be read. */
export async function splunkTheme(fetchFn: (u: string, i?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): Promise<"light" | "dark" | null> {
  try {
    const r = await fetchFn(splunkdUrl("/servicesNS/-/user-prefs/data/user-prefs/general?output_mode=json"), { credentials: "same-origin" });
    if (!r.ok) return null;
    const t = ((await r.json()) as { entry?: { content?: { theme?: string } }[] }).entry?.[0]?.content?.theme;
    return t === "dark" ? "dark" : t === "light" || t === "enterprise" ? "light" : null;
  } catch {
    return null;
  }
}

export async function applyTheme(choice: ThemeChoice = savedTheme()): Promise<void> {
  if (choice !== "auto") return apply(choice);
  apply(null); // the system's, until Splunk's is known
  if (IN_SPLUNK) apply(await splunkTheme());
}

export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === "auto") globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, choice);
  } catch {
    // storage blocked: applies to this page only
  }
  void applyTheme(choice);
}
