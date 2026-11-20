/**
 * Readable property names and values for object pages: "retentionDays" -> "Retention
 * (days)", ISO dates in local time, sizes in MB/GB, durations, percentages. Splunk's own
 * setting names (DEST_KEY, action.email.to, TRANSFORMS-route) are left as they are:
 * admins know them by those names.
 */

/** Names whose label is not just the words of the key. */
const LABELS: Record<string, string> = {
  currentDBSizeMB: "Current size",
  licenseMBPerDay: "Licence use per day",
  totalEventCount: "Events",
  retentionDays: "Retention (days)",
  maxTotalDataSizeMB: "Size limit",
  maxGlobalDataSizeMB: "Size limit (SmartStore, cluster)",
  frozenTimePeriodInSecs: "Retention (frozenTimePeriodInSecs)",
  frozenAction: "When data freezes",
  homePath: "Hot/warm path",
  coldPath: "Cold path",
  remotePath: "SmartStore remote path",
  coldToFrozenDir: "Frozen archive directory",
  datatype: "Data type",
  sizeMB: "Size",
  completePercent: "Complete",
  timeRangeSecs: "Time range",
  lastRunSecs: "Last build took",
  accessCount: "Uses",
  lastAccess: "Last used",
  lastBuilt: "Last built",
  isScheduled: "Scheduled",
  cronSchedule: "Schedule (cron)",
  earliestTime: "Earliest time",
  latestTime: "Latest time",
  dispatchAs: "Runs as",
  uiDispatchApp: "Opens in app",
  alertSeverity: "Alert severity",
  alertSuppress: "Throttled",
  realtime: "Real-time",
  isEval: "Eval macro",
  useAck: "Indexer acknowledgement",
  hecEnabled: "HTTP Event Collector on",
  allowedIndexes: "Allowed indexes",
  outputGroup: "Output group",
  settingNames: "Own settings (names only)",
  modularInputTitle: "Input type",
  srchIndexesAllowed: "Searchable indexes",
  srchIndexesDefault: "Default indexes",
  importedSrchIndexesAllowed: "Searchable indexes (inherited)",
  importedRoles: "Inherits roles",
  importedCapabilities: "Capabilities (inherited)",
  srchFilter: "Search filter",
  srchTimeWin: "Search time window",
  srchJobsQuota: "Search jobs quota",
  srchDiskQuota: "Search disk quota",
  neverExpires: "Never expires",
  restrictedRoles: "Limited to roles",
  identityProvider: "Identity provider",
  issuedAt: "Issued",
  expiresAt: "Expires",
  notBefore: "Valid from",
  passAuth: "Passes the user's session",
  requiresSearchInfo: "Needs search info",
  pythonRequired: "Python",
  retainsEvents: "Keeps events",
  scriptType: "Script type",
  closes: "Closes the finding",
  statusType: "For",
  wholeDetection: "Hides the whole detection",
  dataSource: "Data source",
  connectionType: "Connection type",
  supportedCapabilities: "Capabilities",
  accessLevel: "Access level",
  authMethods: "Authentication",
  azureTenantId: "Azure tenant ID",
  tenantId: "Tenant ID",
  clientId: "Client (application) ID",
  cloudEnvironment: "Cloud",
  tenantSubdomain: "Tenant subdomain",
  tenantDataCenter: "Tenant data center",
  accountKind: "Account type",
  addOn: "Add-on",
  objectType: "Object type",
  resourceName: "Resource name",
  catalogId: "Catalog ID",
  planId: "Plan ID",
  templateId: "Template ID",
  summaryId: "Summary ID",
  definedIn: "Defined in apps",
  storageAccount: "Storage account",
  filePrefix: "File prefix",
  dataFormat: "Format",
  compressionType: "Compression",
  indexerDiscovery: "Indexer discovery",
  clusterManager: "Cluster manager",
  datasetType: "Remote dataset type",
  providerType: "Provider type",
  hostPort: "Host and port",
  serviceAccount: "Service account",
  appContext: "App context",
  indexesAllowed: "Indexes allowed",
  connectivityStatus: "Connectivity",
  awsRegion: "AWS region",
  awsAccountId: "AWS account",
  glueDatabase: "AWS Glue database",
  glueTablesAllowed: "AWS Glue tables allowed",
  s3PathsAllowed: "S3 paths allowed",
};

const ACRONYMS: Record<string, string> = {
  id: "ID", ids: "IDs", url: "URL", uri: "URI", mb: "MB", gb: "GB", hec: "HEC", spl: "SPL",
  spl2: "SPL2", ssl: "SSL", tls: "TLS", kv: "KV", api: "API", aws: "AWS", es: "ES", ip: "IP",
  sql: "SQL", dm: "DM", db: "DB", ui: "UI", http: "HTTP", tcp: "TCP", udp: "UDP", csv: "CSV", json: "JSON",
};

/** A Splunk setting name, kept verbatim: UPPER_CASE, dotted, dashed or "::"-scoped. */
const SPLUNK_NAME = /^[A-Z0-9_]+(-.*)?$|[.:]|^[A-Z]+-/;

export function propLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  if (SPLUNK_NAME.test(key)) return key;
  const words = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (!words.length) return key;
  const first = words[0];
  words[0] = first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1);
  return words.join(" ");
}

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z| ?UTC|[+-]\d{2}:?\d{2})?$/;

/** Milliseconds for an ISO date-time, also Splunk's "2026-11-06 07:45:00 UTC". */
export const parseDate = (v: string): number => Date.parse(v.replace(/ ?UTC$/, "Z").replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T"));

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(parseDate(v));

/** "3 days ago", "in 5 hours". */
export function relative(iso: string, now: number = Date.now()): string {
  const secs = (parseDate(iso) - now) / 1000;
  const abs = Math.abs(secs);
  const [n, unit] =
    abs < 90 ? [Math.round(abs), "second"]
    : abs < 5400 ? [Math.round(abs / 60), "minute"]
    : abs < 129600 ? [Math.round(abs / 3600), "hour"]
    : abs < 86400 * 60 ? [Math.round(abs / 86400), "day"]
    : abs < 86400 * 730 ? [Math.round(abs / (86400 * 30.4)), "month"]
    : [Math.round(abs / (86400 * 365)), "year"];
  const text = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return secs < 0 ? `${text} ago` : `in ${text}`;
}

export const fmtSizeMB = (mb: number) =>
  mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(1)} TB` : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toLocaleString()} MB`;

export function fmtDuration(secs: number): string {
  if (secs < 120) return `${Math.round(secs * 10) / 10} s`;
  if (secs < 7200) return `${Math.round(secs / 60)} min`;
  if (secs < 172800) return `${Math.round(secs / 360) / 10} h`;
  return `${Math.round(secs / 8640) / 10} days`;
}

/** A number with the unit its key implies, or undefined if the key implies none. */
export function numberWithUnit(key: string, n: number): string | undefined {
  if (/MBPerDay$/.test(key)) return `${n < 1 ? `${Math.round(n * 1024).toLocaleString()} KB` : fmtSizeMB(n)} a day`;
  if (/(SizeMB|sizeMB|MB)$/.test(key)) return fmtSizeMB(n);
  if (/(Secs|Seconds|InSecs)$/.test(key)) return fmtDuration(n);
  if (/Percent$/.test(key)) return `${n.toLocaleString()}%`;
  if (/Days$/.test(key)) return `${n.toLocaleString()} day${n === 1 ? "" : "s"}`;
  return undefined;
}

/** Keys whose string value names another catalogued object, and that object's type. */
export const REFERENCE_KEYS: Record<string, string> = {
  dashboard: "dashboard",
  dataModel: "dataModel",
  connection: "spl2Connection",
  provider: "federatedProvider",
  user: "user",
  issuedBy: "user",
  account: "addOnAccount",
  indexerDiscovery: "",
  defaultApp: "app",
  uiDispatchApp: "app",
  sourcetype: "sourcetype",
  index: "index",
};

/** Coded values in words, per key. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  frozenAction: {
    delete: "Deleted",
    archiveDir: "Archived to a directory",
    archiveScript: "Archived by a script",
    activeArchive: "Kept in Splunk Cloud Active Archive (DDAA)",
    selfStorage: "Copied to Self Storage (DDSS)",
  },
  protocol: { v1: "v1 (legacy)", v2: "v2 (chunked)" },
  datatype: { event: "Events", metric: "Metrics" },
  model: { classic: "Local buckets", smartStore: "SmartStore" },
  ruleType: { aggregation: "Aggregation", suppression: "Suppression" },
  // Splunk's alert.severity: 1 debug to 6 critical.
  alertSeverity: { "1": "1 (debug)", "2": "2 (info)", "3": "3 (low)", "4": "4 (medium)", "5": "5 (high)", "6": "6 (critical)" },
};

export function valueLabel(key: string | undefined, value: string): string {
  return (key && VALUE_LABELS[key]?.[value]) ?? value;
}
