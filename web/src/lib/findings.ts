/**
 * Findings: every health check of every object in one list, most severe first. The
 * checks are computed at build time (ingestion health.py); this only flattens them.
 */
import type { Entity } from "../generated/catalog";
import { typeGroup } from "./labels";

export interface Finding {
  entity: Entity;
  check: string;
  status: "warning" | "critical";
  message: string;
}

/** What each check is about, in words (unknown ones fall back to their id). */
export const CHECK_TITLES: Record<string, string> = {
  freshness: "No recent data",
  volume: "Unusual volume",
  ingestDelay: "Ingestion delay",
  parsing: "Parsing warnings",
  skipped: "Skipped scheduled runs",
  failed: "Failed scheduled runs",
  runtime: "Long run time",
  notRunning: "Scheduled but not running",
  silent: "Forwarder silent",
  phoneHome: "Deployment client not phoning home",
  deployment: "App deployment failed",
  hecOff: "HTTP Event Collector off",
  hecRejected: "HEC requests rejected",
  hecErrors: "HEC errors",
  hecDisabledInUse: "Disabled HEC token still used",
  alertNoisy: "Noisy alert",
  tokenExpired: "Token expired",
  tokenExpiring: "Token expiring soon",
  tokenNoExpiry: "Token never expires",
  tokenStale: "Token unused",
  tokenNoOwner: "Token without a user",
  retentionBySize: "Losing data by size",
  routeToMissingIndex: "Routing to a missing index",
  summaryError: "Acceleration build failed",
  summaryUnused: "Acceleration not used",
  riskyCommand: "Runs a risky command",
  fieldFilterOnBuilder: "Field filter limits the catalog build",
  riskyCapability: "Role grants high-risk capabilities",
  suppressionExpired: "Suppression ended",
  suppressesWholeDetection: "Suppression hides a whole detection",
};

export const checkTitle = (check: string): string => CHECK_TITLES[check] ?? check;

export function findings(entities: Entity[]): Finding[] {
  const out: Finding[] = [];
  for (const entity of entities) {
    for (const c of entity.health?.checks ?? []) {
      if (c.status !== "warning" && c.status !== "critical") continue;
      out.push({ entity, check: c.check, status: c.status, message: c.message });
    }
  }
  const rank = { critical: 0, warning: 1 };
  return out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      checkTitle(a.check).localeCompare(checkTitle(b.check)) ||
      (a.entity.displayName ?? a.entity.name).localeCompare(b.entity.displayName ?? b.entity.name),
  );
}

export interface FindingFilters {
  status?: string;
  check?: string;
  area?: string;
  app?: string;
  /** Instance (stack) id. */
  instance?: string;
  text?: string;
}

export function filterFindings<T extends Finding>(all: T[], f: FindingFilters): T[] {
  const text = f.text?.trim().toLowerCase();
  return all.filter(
    (x) =>
      (!f.status || x.status === f.status) &&
      (!f.check || x.check === f.check) &&
      (!f.area || typeGroup(x.entity.type) === f.area) &&
      (!f.app || (x.entity.app ?? "") === f.app) &&
      (!f.instance || x.entity.instance === f.instance) &&
      (!text ||
        [x.message, x.entity.name, x.entity.displayName, x.entity.owner, ...(x.entity.annotations?.owners ?? [])]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(text))),
  );
}
