/**
 * The Health page's logic: sections, the checks in them, what to do about each, the
 * per-owner and per-app summaries, changes since the last build and daily series.
 * Pure functions (the page and the tests share them).
 */
import type { CatalogBundle, Entity } from "../generated/catalog";
import { isHandled, type Ack } from "./acks";
import { checkTitle } from "./findings";
import type { DailySeries } from "./health";

export type Severity = "warning" | "critical";

export interface Section {
  id: string;
  title: string;
  checks: string[];
  empty: string;
}

/** Every check belongs to one section; a check not listed goes to "Other". */
export const SECTIONS: Section[] = [
  { id: "data", title: "Data sources", checks: ["freshness", "volume", "ingestDelay", "parsing"], empty: "Every index and sourcetype looks healthy." },
  { id: "searches", title: "Scheduled searches and alerts", checks: ["skipped", "failed", "runtime", "notRunning", "alertNoisy"], empty: "No skipped, failing, missing or noisy scheduled searches." },
  { id: "forwarders", title: "Forwarders and deployment", checks: ["silent", "phoneHome", "deployment", "relay"], empty: "Every forwarder and client reported recently." },
  { id: "db", title: "DB Connect", checks: ["dbMissing", "dbFailed", "dbNotRunning"], empty: "Every DB Connect input and output has what it needs and runs." },
  { id: "hec", title: "HTTP Event Collector", checks: ["hecOff", "hecRejected", "hecErrors", "hecDisabledInUse"], empty: "No HEC problems." },
  { id: "storage", title: "Storage, routing and acceleration", checks: ["retentionBySize", "routeToMissingIndex", "summaryError", "summaryUnused"], empty: "No storage, routing or acceleration problems." },
  { id: "access", title: "Access: tokens, field filters, capabilities", checks: ["tokenExpired", "tokenExpiring", "tokenNoExpiry", "tokenStale", "tokenNoOwner", "fieldFilterOnBuilder", "riskyCapability"], empty: "No token, field filter or capability problems." },
  { id: "ownership", title: "Owners no longer here", checks: ["orphaned"], empty: "Every object's owner still exists." },
  { id: "commands", title: "Risky commands", checks: ["riskyCommand"], empty: "No search runs a command that deletes data, runs programs or sends data out." },
  { id: "es", title: "Enterprise Security", checks: ["suppressionExpired", "suppressesWholeDetection"], empty: "No suppression problems." },
  { id: "other", title: "Other", checks: [], empty: "Nothing else." },
];

const SECTION_OF = new Map(SECTIONS.flatMap((s) => s.checks.map((c) => [c, s.id] as const)));
export const sectionOf = (check: string): string => SECTION_OF.get(check) ?? "other";

// --- what to do --------------------------------------------------------------------------

export interface Remedy {
  /** Why it matters. */
  why: string;
  /** What to do. */
  fix: string;
  /** A search to look into it, for this object. */
  spl?: (e: Entity) => string;
}

const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const searchName = (e: Entity) => q(e.name);
const app = (e: Entity) => (e.app ? ` app=${q(e.app)}` : "");
const props = (e: Entity) => (e.properties ?? {}) as Record<string, unknown>;

export const REMEDIES: Record<string, Remedy> = {
  freshness: {
    why: "Searches, dashboards and detections that read this data see nothing new: alerts stay quiet because there is nothing to alert on.",
    fix: "Check the forwarders and inputs that send it (Lineage tab), their connection to the indexers, and whether the source itself stopped writing.",
    spl: (e) => `| tstats latest(_time) as latest count where ${e.type === "index" ? `index=${q(e.name)}` : `index=* sourcetype=${q(e.name)}`} by host | eval age_hours=round((now()-latest)/3600,1) | sort - age_hours`,
  },
  volume: {
    why: "A sudden drop usually means a source stopped sending; a spike can be a loop, a debug log left on, or an attack, and it costs licence.",
    fix: "Compare today with the usual day by host and source; look for one host or source that changed.",
    spl: (e) => `| tstats count where ${e.type === "index" ? `index=${q(e.name)}` : `index=* sourcetype=${q(e.name)}`} by _time span=1h, host | timechart span=1h sum(count) by host limit=10`,
  },
  ingestDelay: {
    why: "Events arrive late, so real-time and scheduled searches miss them, and detections fire late or never.",
    fix: "Look for blocked queues on forwarders and indexers, a time zone or timestamp problem (events far in the future or past), or a forwarder sending a backlog.",
    spl: (e) => `index=* ${e.type === "index" ? `index=${q(e.name)}` : `sourcetype=${q(e.name)}`} earliest=-1h | eval lag=_indextime-_time | stats avg(lag) as avg_lag max(lag) as max_lag by host | sort - max_lag`,
  },
  parsing: {
    why: "Line breaking or timestamp warnings mean events may be merged, split or given the wrong time.",
    fix: "Fix the sourcetype's props.conf: LINE_BREAKER, SHOULD_LINEMERGE, TIME_PREFIX, TIME_FORMAT, MAX_TIMESTAMP_LOOKAHEAD.",
    spl: (e) => `index=_internal sourcetype=splunkd (component=LineBreakingProcessor OR component=DateParserVerbose OR component=AggregatorMiningProcessor) data_sourcetype=${q(e.name)} | stats count by component, log_level, message | sort - count`,
  },
  skipped: {
    why: "Skipped runs leave gaps: an alert or summary that should have covered that time did not.",
    fix: "Spread schedules (avoid everything at :00), add a schedule window, lower the priority of less important searches, or raise the search head's concurrency limits.",
    spl: (e) => `index=_internal sourcetype=scheduler savedsearch_name=${searchName(e)}${app(e)} status=skipped | stats count by reason | sort - count`,
  },
  failed: {
    why: "Failed runs produce no results: an alert that fails silently looks the same as one with nothing to say.",
    fix: "Open the run's job log; fix the search, or the lookups, macros and permissions it depends on.",
    spl: (e) => `index=_internal sourcetype=scheduler savedsearch_name=${searchName(e)}${app(e)} (status=*fail* OR status=abandoned) | table _time status reason result_count run_time | sort - _time`,
  },
  runtime: {
    why: "Long runs hold search slots and make other scheduled searches skip.",
    fix: "Narrow the time range and indexes, use tstats or an accelerated data model, or schedule it less often.",
    spl: (e) => `index=_internal sourcetype=scheduler savedsearch_name=${searchName(e)}${app(e)} | timechart span=1h max(run_time) as max_run_time avg(run_time) as avg_run_time`,
  },
  notRunning: {
    why: "It is scheduled but the scheduler never ran it: whatever relies on it is not happening.",
    fix: "Check its owner still exists, the app is enabled, the cron schedule is valid, and the scheduler is enabled on this search head.",
    spl: (e) => `| rest /servicesNS/-/-/saved/searches splunk_server=local search="title=${e.name.replace(/"/g, "")}" | table title eai:acl.app eai:acl.owner disabled is_scheduled cron_schedule next_scheduled_time`,
  },
  alertNoisy: {
    why: "An alert that fires many times a day trains people to ignore it; real problems get lost.",
    fix: "Tighten the condition, add throttling (suppression) per entity, or turn it into a report or a risk rule.",
    spl: (e) => `index=_audit action=alert_fired ss_name=${searchName(e)} | timechart span=1d count`,
  },
  silent: {
    why: "Nothing from this forwarder reaches the indexers: every source on it has stopped.",
    fix: "Check the host is up, splunkd is running there, and it can reach the indexers (outputs.conf, network, certificates).",
    spl: (e) => `index=_internal source=*metrics.log group=tcpin_connections (hostname=${q(e.name)} OR sourceHost=${q(e.name)}) | stats latest(_time) as last_seen by hostname, sourceIp | eval last_seen=strftime(last_seen, "%F %T")`,
  },
  phoneHome: {
    why: "It no longer checks in with the deployment server, so it does not get app or configuration changes.",
    fix: "Check deploymentclient.conf (targetUri), the network to the deployment server, and that splunkd is running.",
    spl: (e) => `index=_internal sourcetype=splunkd component=DeploymentClient host=${q(e.name)} | table _time log_level message | sort - _time`,
  },
  deployment: {
    why: "Apps the deployment server sends did not install, so this client runs old or missing configuration.",
    fix: "Look at the client's splunkd.log for the install error (often permissions, disk space or a bad app).",
    spl: (e) => `index=_internal sourcetype=splunkd component=DeployedApplication host=${q(e.name)} log_level!=INFO | table _time log_level message | sort - _time`,
  },
  relay: {
    why: "This client is a second-tier deployment server: it keeps the apps it gets in its deployment-apps folder to pass on, so it cannot enable them. Classes that send it apps to enable make the install fail at every phone home.",
    fix: "Set stateOnClient = noop on the server classes that send apps to it (or keep it out of them, for example by narrowing a whitelist of *), then reload the deployment server.",
    spl: (e) => `index=_internal sourcetype=splunkd component=DeployedApplication host=${q(e.name)} "Failed to install" | stats count latest(_time) as last by message | eval last=strftime(last, "%F %T")`,
  },
  dbMissing: {
    why: "DB Connect cannot open the connection, so every input, output and lookup on it fails, and no data arrives.",
    fix: "Create or enable the identity or connection it names in DB Connect (Configuration > Databases), or point it at one that exists.",
  },
  dbFailed: {
    why: "Runs of this DB Connect job fail: an input misses rows from the database, an output does not write them.",
    fix: "Look at DB Connect's server log for the error (sign-in, network, SQL, a changed table), fix it, then check the next run.",
    spl: (e) => `index=_internal sourcetype=dbx_job_metrics (input_name=${q(e.name)} OR output_name=${q(e.name)}) | table _time status read_count write_count error_count duration | sort - _time`,
  },
  dbNotRunning: {
    why: "DB Connect records runs of other jobs but none of this one: it is not scheduled, or DB Connect stopped running it.",
    fix: "Check its interval and that it is enabled in DB Connect, and look for errors about it in DB Connect's server log.",
    spl: (e) => `index=_internal sourcetype=dbx_server ${q(e.name)} | table _time log_level message | sort - _time`,
  },
  hecOff: {
    why: "HTTP Event Collector is off: every HEC token on this instance refuses data.",
    fix: "Enable it under Settings > Data inputs > HTTP Event Collector > Global Settings, if senders still need it.",
  },
  hecRejected: {
    why: "Senders use this token but their requests are refused: that data is lost.",
    fix: "Check the token value the senders use, the indexes the token allows, and its default index.",
    spl: (e) => `index=_internal sourcetype=splunkd component=HttpInputDataHandler (token_name=${q(e.name)} OR name=${q(e.name)}) | stats count by reason, message | sort - count`,
  },
  hecErrors: {
    why: "Requests to this token fail, so some events never arrive.",
    fix: "Look at the error reasons: bad formatting, oversized events, or an index the token may not write to.",
    spl: (e) => `index=_introspection component=HttpEventCollector data.token_name=${q(e.name)} | stats sum(data.num_of_errors) as errors sum(data.num_of_parser_errors) as parser_errors by data.token_name`,
  },
  hecDisabledInUse: {
    why: "The token is disabled but something still sends to it: those events are dropped.",
    fix: "Find the sender (by source IP) and move it to an enabled token, or enable this one again.",
    spl: (e) => `index=_internal sourcetype=splunkd component=HttpInputDataHandler "disabled" ${q(e.name)} | stats count by host, message`,
  },
  retentionBySize: {
    why: "The index is close to its size limit, so data is frozen (usually deleted) by size, before the retention period you set.",
    fix: "Raise maxTotalDataSizeMB (or the volume's size), lower the incoming volume, or accept the shorter retention and write it down.",
    spl: (e) => `| rest /services/data/indexes/${encodeURIComponent(e.name)} splunk_server=local | table title currentDBSizeMB maxTotalDataSizeMB frozenTimePeriodInSecs minTime maxTime`,
  },
  routeToMissingIndex: {
    why: "A transform sends events to an index that does not exist here: they are dropped, or go to the last-chance index.",
    fix: "Create the index, or fix the transform's FORMAT / DEST_KEY.",
  },
  summaryError: {
    why: "The acceleration summary does not build, so searches that use it fall back to slow raw searches, or show partial results.",
    fix: "Open the data model or report and look at its acceleration status; rebuild after fixing the search or permissions.",
    spl: () => `index=_internal sourcetype=scheduler savedsearch_name="_ACCELERATE_*" status!=success | stats count by savedsearch_name, status, reason`,
  },
  orphaned: {
    why: "Its owner no longer exists in Splunk. A scheduled search owned by a removed user does not run, and nobody can change a private object any more; shared ones stay but nobody is answerable for them.",
    fix: "Reassign it to a current user or team account (Settings > All configurations > Reassign Knowledge Objects), or delete it if it is no longer needed. Reassign before removing users next time.",
    spl: (e) => `| rest /servicesNS/-/-/saved/searches splunk_server=local count=0 | search eai:acl.owner=${q(e.owner ?? "")} | table title eai:acl.app eai:acl.sharing is_scheduled disabled`,
  },
  riskyCapability: {
    why: "A custom role grants capabilities that change who may do what, read secrets, run code, delete data or change the platform. Everyone holding the role, or a role that imports it, can do so.",
    fix: "Check each capability is needed; move it to a separate role given only to the people who need it, or remove it.",
  },
  fieldFilterOnBuilder: {
    why: "Field filters apply to the account that builds the catalog unless one of its roles is exempt: the build's searches see filtered data, and Splunk restricts commands such as tstats and mstats for it, so objects and data can be missing from the catalog.",
    fix: "Exempt one of the building account's roles from the filter (field filter settings, role exemptions), then build again.",
  },
  riskyCommand: {
    why: "The search deletes events, runs a program or script on the search head, runs a search for every result, or sends data out of Splunk. A mistake, or a change by someone who can edit it, has effects beyond its results.",
    fix: "Check the search is still wanted and that only the right roles can edit and run it; for delete, run it by hand rather than on a schedule. Splunk asks users to confirm risky commands unless it is turned off.",
  },
  summaryUnused: {
    why: "It costs disk and indexer CPU to keep it up to date, and no search uses it.",
    fix: "Turn its acceleration off, or shorten the summary range.",
  },
  suppressionExpired: {
    why: "The suppression's end date has passed: it does nothing now and only clutters the list.",
    fix: "Delete it, or extend it if the suppression is still wanted.",
  },
  suppressesWholeDetection: {
    why: "It hides every finding from a detection, not just the noisy ones: that detection is effectively off.",
    fix: "Narrow it to the fields that make the noise (host, user, signature), or tune the detection itself.",
  },
  tokenExpired: {
    why: "The token no longer works; whatever used it is failing.",
    fix: "Issue a new token for the integration and delete this one.",
  },
  tokenExpiring: {
    why: "The integration that uses this token stops working when it expires.",
    fix: "Issue a replacement now and switch the integration before the expiry date.",
  },
  tokenNoExpiry: {
    why: "A token that never expires stays valid if it leaks.",
    fix: "Issue a replacement with an expiry date, then disable this one.",
  },
  tokenStale: {
    why: "Unused for a long time: probably not needed, and still a way in.",
    fix: "Ask its owner; disable it, then delete it if nothing breaks.",
  },
  tokenNoOwner: {
    why: "Its user no longer exists, so no one is responsible for it.",
    fix: "Find what uses it, issue a token for a current user, and delete this one.",
  },
};

export const remedy = (check: string): Remedy | undefined => REMEDIES[check];

/** A Splunk search link: the instance's Splunk Web when known, this Splunk Web inside the app. */
export function searchLink(spl: string, webUrl: string | undefined, inSplunk: boolean, prefix = ""): string | undefined {
  const query = `q=${encodeURIComponent(spl.startsWith("|") ? spl : `search ${spl}`)}`;
  if (webUrl) return `${webUrl.replace(/\/$/, "")}/app/search/search?${query}`;
  if (inSplunk) return `${prefix}/app/search/search?${query}`;
  return undefined;
}

// --- findings -------------------------------------------------------------------------

export interface Item {
  entity: Entity;
  check: string;
  status: Severity;
  message: string;
  since?: string;
  section: string;
  /** New since the previous build. */
  isNew: boolean;
  ack?: Ack;
  handled: boolean;
}

export interface Filters {
  status?: Severity | "";
  section?: string;
  check?: string;
  owner?: string;
  app?: string;
  /** Instance (stack) id. */
  instance?: string;
  text?: string;
  onlyNew?: boolean;
  showHandled?: boolean;
}

/** Whether the bundle can tell new findings from old: it has an earlier build to compare with. */
export const hasPrevious = (bundle: CatalogBundle): boolean => (bundle.healthHistory?.length ?? 0) > 1;

export function items(entities: Entity[], bundle: CatalogBundle, acks: Map<string, Ack>, now: Date = new Date()): Item[] {
  const compare = hasPrevious(bundle);
  const out: Item[] = [];
  for (const entity of entities) {
    for (const c of entity.health?.checks ?? []) {
      if (c.status !== "warning" && c.status !== "critical") continue;
      const ack = acks.get(`${entity.id}\u0000${c.check}`);
      out.push({
        entity,
        check: c.check,
        status: c.status,
        message: c.message,
        since: c.since,
        section: sectionOf(c.check),
        isNew: compare && !!c.since && c.since === bundle.generatedAt,
        ack,
        handled: isHandled(ack, c.status, now),
      });
    }
  }
  return out;
}

export const ownerOf = (e: Entity): string => {
  const p = props(e);
  return e.owner ?? (typeof p.user === "string" ? p.user : "") ?? "";
};

export function filterItems(all: Item[], f: Filters): Item[] {
  const text = f.text?.trim().toLowerCase();
  return all.filter(
    (x) =>
      (f.showHandled || !x.handled) &&
      (!f.status || x.status === f.status) &&
      (!f.section || x.section === f.section) &&
      (!f.check || x.check === f.check) &&
      (!f.owner || ownerOf(x.entity) === f.owner) &&
      (!f.app || (x.entity.app ?? "") === f.app) &&
      (!f.instance || x.entity.instance === f.instance) &&
      (!f.onlyNew || x.isNew) &&
      (!text ||
        `${x.entity.displayName ?? x.entity.name} ${x.entity.app ?? ""} ${x.message} ${checkTitle(x.check)}`.toLowerCase().includes(text)),
  );
}

export interface ObjectRow {
  entity: Entity;
  status: Severity;
  items: Item[];
}

/** Items of one section, one row per object, worst first. */
export function objectRows(list: Item[]): ObjectRow[] {
  const by = new Map<string, ObjectRow>();
  for (const x of list) {
    const row = by.get(x.entity.id) ?? { entity: x.entity, status: "warning" as Severity, items: [] };
    row.items.push(x);
    if (x.status === "critical") row.status = "critical";
    by.set(x.entity.id, row);
  }
  return [...by.values()].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "critical" ? -1 : 1) ||
      (a.entity.displayName ?? a.entity.name).localeCompare(b.entity.displayName ?? b.entity.name),
  );
}

export interface CheckCount {
  check: string;
  section: string;
  critical: number;
  warning: number;
}

/** Findings per check, most first. */
export function checkCounts(list: Item[]): CheckCount[] {
  const by = new Map<string, CheckCount>();
  for (const x of list) {
    const c = by.get(x.check) ?? { check: x.check, section: x.section, critical: 0, warning: 0 };
    c[x.status] += 1;
    by.set(x.check, c);
  }
  return [...by.values()].sort((a, b) => b.critical + b.warning - (a.critical + a.warning) || b.critical - a.critical || checkTitle(a.check).localeCompare(checkTitle(b.check)));
}

export interface GroupRow {
  key: string;
  objects: number;
  critical: number;
  warning: number;
  newFindings: number;
  /** Most common checks, for the summary. */
  top: string[];
}

/** Who needs to act: findings per owner (or per app). */
export function groupRows(list: Item[], by: "owner" | "app"): GroupRow[] {
  const groups = new Map<string, { objects: Set<string>; critical: number; warning: number; newFindings: number; checks: Map<string, number> }>();
  for (const x of list) {
    const key = (by === "owner" ? ownerOf(x.entity) : x.entity.app) || "";
    const g = groups.get(key) ?? { objects: new Set(), critical: 0, warning: 0, newFindings: 0, checks: new Map() };
    g.objects.add(x.entity.id);
    g[x.status] += 1;
    if (x.isNew) g.newFindings += 1;
    g.checks.set(x.check, (g.checks.get(x.check) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      objects: g.objects.size,
      critical: g.critical,
      warning: g.warning,
      newFindings: g.newFindings,
      top: [...g.checks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${checkTitle(c)} (${n})`),
    }))
    .sort((a, b) => b.critical - a.critical || b.critical + b.warning - (a.critical + a.warning) || a.key.localeCompare(b.key));
}

// --- thresholds ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Record<string, number> = {
  staleWarningHours: 24,
  staleCriticalHours: 168,
  volumeLowRatio: 0.3,
  volumeHighRatio: 3,
  delayWarningSecs: 600,
  skipWarningRatio: 0.1,
  alertNoisyPerDay: 24,
  tokenExpiryWarningDays: 14,
  tokenStaleDays: 90,
};

const hours = (h: number) => (h % 24 === 0 && h >= 48 ? `${h / 24} days` : h === 1 ? "1 hour" : `${h} hours`);
const pct = (r: number) => `${Math.round(r * 100)}%`;
const mins = (s: number) => (s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`);

/** The thresholds in a sentence: from the build's health report, or the defaults for older catalogs. */
export function thresholdText(t: Record<string, number> | undefined): string {
  const v = { ...DEFAULT_THRESHOLDS, ...(t ?? {}) };
  return [
    `stale after ${hours(v.staleWarningHours)} (critical after ${hours(v.staleCriticalHours)})`,
    `volume below ${pct(v.volumeLowRatio)} or above ${pct(v.volumeHighRatio)} of the usual day`,
    `ingestion more than ${mins(v.delayWarningSecs)} behind`,
    `more than ${pct(v.skipWarningRatio)} of scheduled runs skipped`,
    `alerts firing more than ${v.alertNoisyPerDay} times a day`,
    `tokens expiring within ${v.tokenExpiryWarningDays} days or unused for ${v.tokenStaleDays}`,
  ].join(", ");
}

// --- series -----------------------------------------------------------------------------

/** Skipped or failed scheduled runs per day. */
export function problemSeries(e: Entity): DailySeries | null {
  const d = (e.usage?.scheduler as { daily?: { start: string; problems: number[] } } | undefined)?.daily;
  return d && Array.isArray(d.problems) && d.problems.length > 1 ? { start: d.start, counts: d.problems } : null;
}

/** Times an alert fired per day. */
export function alertSeries(e: Entity): DailySeries | null {
  const d = e.usage?.alertDaily;
  return d && Array.isArray(d.counts) && d.counts.length > 1 ? { start: d.start, counts: d.counts } : null;
}

// --- cleanup --------------------------------------------------------------------------

/** Objects that refer to this one (dependents), from the catalog's edges. */
export const DEPENDENT_EDGES = new Set(["uses", "reads", "feeds", "writes"]);

/** Size on disk an unused index would free, in MB. */
export function reclaimableMB(e: Entity): number | undefined {
  if (e.type !== "index") return undefined;
  const mb = (props(e).observed as Record<string, unknown> | undefined)?.currentDBSizeMB;
  return typeof mb === "number" && mb > 0 ? mb : undefined;
}

export function sizeText(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb).toLocaleString()} MB`;
}

/** "3 days ago", "today": how long since an ISO time. */
export function ago(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((now.getTime() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** Splunk-authored and product apps (as the build judges "built-in" for cleanup). */
export function builtinApps(entities: Entity[]): Set<string> {
  return new Set(
    entities
      .filter((e) => {
        if (e.type !== "app") return false;
        const p = props(e);
        return String(p.author ?? "").toLowerCase().includes("splunk") || !!p.builtin || (e.product !== undefined && e.product !== "splunk");
      })
      .map((e) => e.name),
  );
}

/** Kinds of object it makes sense to delete when they are disabled. */
export const CLEANUP_TYPES = new Set([
  "savedSearch", "correlationSearch", "dashboard", "macro", "lookup", "eventtype", "tag", "dataModel",
  "kvCollection", "input", "authToken", "index", "transform", "fieldExtraction", "workflowAction", "scheduledView",
]);
