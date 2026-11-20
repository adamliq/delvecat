import type { Database, SqlValue } from "sql.js";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { effectiveDescription } from "./annotate";
import { access, effectiveClassifications, isSensitive } from "./governance";
import type { Risk } from "./risk";

/** Tables the SQL console exposes. Built from the loaded (possibly redacted) bundle. */
export interface Column {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL";
  doc?: string;
}
export interface Table {
  name: string;
  doc: string;
  columns: Column[];
  rows: SqlValue[][];
}

type Cell = SqlValue | boolean | undefined | unknown[] | Record<string, unknown>;

/** SQLite has no booleans or lists: booleans become 1/0, objects and lists JSON text. */
function cell(v: Cell): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

const col = (name: string, type: Column["type"] = "TEXT", doc?: string): Column => ({ name, type, doc });

export function catalogTables(bundle: CatalogBundle, risk: Map<string, Risk> = new Map()): Table[] {
  const E = bundle.entities;
  const per = <T,>(fn: (e: Entity) => T[]) => E.flatMap((e) => fn(e));

  const entities: Table = {
    name: "entities",
    doc: "One row per catalog object.",
    columns: [
      col("id", "TEXT", "Unique id: instance:type:app/name"),
      col("type"), col("name"), col("display_name"), col("product"), col("instance"), col("app"),
      col("owner", "TEXT", "Splunk owner (see labels for annotated owners)"),
      col("sharing", "TEXT", "global, app, user or system"),
      col("disabled", "INTEGER", "1 if disabled"),
      col("description", "TEXT", "Annotated description, else the Splunk one"),
      col("domain"),
      col("health", "TEXT", "ok, warning or critical"),
      col("sensitive", "INTEGER", "1 if any sensitive classification applies"),
      col("readable_by_everyone", "INTEGER", "1 if every role can read it"),
      col("read_roles", "TEXT", "Roles Splunk lets read it (its permissions), comma-separated; * is every role"),
      col("unused", "INTEGER", "1 if no recorded use"),
      col("runs", "INTEGER"), col("searches", "INTEGER"), col("views", "INTEGER"),
      col("alert_fires", "INTEGER", "Alerts and detections: times triggered in the usage window"),
      col("alerts_suppressed", "INTEGER", "Triggers suppressed by throttling"),
      col("last_used"), col("updated_at"), col("first_seen_at"), col("version", "INTEGER"),
      col("url", "TEXT", "Link to the object in Splunk"),
      col("settings", "TEXT", "Splunk settings as JSON; use json_extract(settings, '$.cronSchedule')"),
      col("props", "TEXT", "Structured property values as JSON"),
    ],
    rows: E.map((e) => [
      e.id, e.type, e.name, e.displayName, e.product, e.instance, e.app, e.owner, e.sharing, e.disabled ?? false,
      effectiveDescription(e), e.annotations?.domain, e.health?.status, isSensitive(e), access(e)?.everyone,
      e.permissions?.read?.join(", "),
      e.usage?.unused, e.usage?.runs, e.usage?.searches, e.usage?.views,
      e.usage?.alertFires, e.usage?.alertsSuppressed, e.usage?.lastUsed,
      e.updatedAt, e.firstSeenAt, e.version, e.sourceUrl, e.properties, e.annotations?.properties,
    ].map(cell)),
  };

  const edges: Table = {
    name: "edges",
    doc: "Relationships: from_id <type> to_id, e.g. a search reads an index.",
    columns: [col("from_id"), col("to_id"), col("type"), col("origin", "TEXT", "config, spl, connector or annotation")],
    rows: bundle.edges.map((x) => [x.from, x.to, x.type, x.origin].map(cell)),
  };

  const labels: Table = {
    name: "labels",
    doc: "Annotations with several values: owner, tag, term, dataProduct, missingProperty.",
    columns: [col("entity_id"), col("kind"), col("value")],
    rows: per((e) => {
      const a = e.annotations ?? {};
      const kinds: [string, string[] | undefined][] = [
        ["owner", a.owners], ["tag", a.tags], ["term", a.glossaryTerms],
        ["dataProduct", a.dataProducts], ["missingProperty", a.missingProperties],
      ];
      return kinds.flatMap(([k, vs]) => (vs ?? []).map((v) => [e.id, k, v].map(cell)));
    }),
  };

  const classifications: Table = {
    name: "classifications",
    doc: "Classifications on each object, annotated or derived (how / via say where they came from).",
    columns: [
      col("entity_id"), col("name"), col("sensitive", "INTEGER"),
      col("how", "TEXT", "annotated, field, derivedField, sourcetype or lineage"), col("via", "TEXT", "The object it came from or through"),
      col("columns", "TEXT", "Comma-separated columns that hold it; NULL when the whole object is classified"),
    ],
    rows: per((e) => effectiveClassifications(e).map((c) => [e.id, c.name, c.sensitive, c.how, c.via, c.columns?.join(",")].map(cell))),
  };

  const properties: Table = {
    name: "properties",
    doc: "Structured property values, one row per value.",
    columns: [col("entity_id"), col("property"), col("value")],
    rows: per((e) =>
      Object.entries(e.annotations?.properties ?? {}).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((x) => [e.id, k, x as Cell].map(cell)))),
  };

  const settings: Table = {
    name: "settings",
    doc: "Splunk settings, one row per key (nested 'observed' values as observed.<key>). Fields are in the fields table.",
    columns: [col("entity_id"), col("key"), col("value")],
    rows: per((e) => e.type === "field" ? [] :
      Object.entries(e.properties ?? {}).flatMap(([k, v]) =>
        k === "observed" && v && typeof v === "object" && !Array.isArray(v)
          ? Object.entries(v).map(([k2, v2]) => [e.id, `observed.${k2}`, v2 as Cell].map(cell))
          : [[e.id, k, v as Cell].map(cell)])),
  };

  const fieldsTable: Table = {
    name: "fields",
    doc: "Sourcetype fields (sampled or defined in props.conf), one row each.",
    columns: [
      col("entity_id"), col("sourcetype"), col("field"), col("numeric", "INTEGER", "1 if every sampled value was a number; NULL if not sampled"),
      col("fill_rate", "REAL", "Share of sampled events with the field (0-1); NULL if not sampled"),
      col("distinct_values", "INTEGER"), col("defined_in", "TEXT", "configuration, or NULL when seen in sampled events"),
    ],
    rows: E.filter((e) => e.type === "field").map((e) => {
      const p = (e.properties ?? {}) as { sourcetype?: string; field?: string; numeric?: boolean; definedIn?: string; observed?: { coverage?: number; distinctCount?: number } };
      return [e.id, p.sourcetype, p.field, p.numeric, p.observed?.coverage, p.observed?.distinctCount, p.definedIn].map(cell);
    }),
  };

  const healthChecks: Table = {
    name: "health_checks",
    doc: "Health findings (freshness, volume, skipped runs...).",
    columns: [col("entity_id"), col("check_name"), col("status"), col("message")],
    rows: per((e) => (e.health?.checks ?? []).map((c) => [e.id, c.check, c.status, c.message].map(cell))),
  };

  const lineageIssues: Table = {
    name: "lineage_issues",
    doc: "Search problems: unresolved references and lineage warnings.",
    columns: [col("entity_id"), col("kind", "TEXT", "unresolved or warning"), col("detail")],
    rows: per((e) => [
      ...(e.lineage?.unresolved ?? []).map((d) => [e.id, "unresolved", d]),
      ...(e.lineage?.warnings ?? []).map((d) => [e.id, "warning", d]),
    ].map((r) => r.map(cell))),
  };

  const accessTable: Table = {
    name: "access",
    doc: "Who can read each object: roles and users (filtered = role has a search filter).",
    columns: [col("entity_id"), col("principal_type", "TEXT", "role or user"), col("principal"), col("filtered", "INTEGER")],
    rows: per((e) => {
      const a = access(e);
      if (!a) return [];
      return [
        ...a.roles.map((r) => [e.id, "role", r, a.filteredRoles.includes(r)]),
        ...a.users.map((u) => [e.id, "user", u, false]),
      ].map((r) => r.map((v) => cell(v as Cell)));
    }),
  };

  const instances: Table = {
    name: "instances",
    doc: "Splunk instances the bundle was built from.",
    columns: [col("id"), col("name"), col("kind"), col("version"), col("product")],
    rows: bundle.instances.map((i) => [i.id, i.name, i.kind, i.version, i.product].map(cell)),
  };

  const domains: Table = {
    name: "domains",
    doc: "Business domains.",
    columns: [col("name"), col("parent"), col("description")],
    rows: (bundle.domains ?? []).map((d) => [d.name, d.parent, d.description].map(cell)),
  };

  const dataProducts: Table = {
    name: "data_products",
    doc: "Data products and their assets (one row per asset).",
    columns: [col("name"), col("domain"), col("asset_id")],
    rows: (bundle.dataProducts ?? []).flatMap((p) => p.assets.map((a) => [p.name, p.domain, a].map(cell))),
  };

  const fieldIds = new Map<string, string[]>(); // "entity|field name" -> matched field ids
  for (const x of bundle.edges) {
    if (x.type !== "readsField") continue;
    const name = x.to.slice(x.to.lastIndexOf("/") + 1);
    const key = `${x.from}|${name}`;
    fieldIds.set(key, [...(fieldIds.get(key) ?? []), x.to]);
  }
  const fieldUsage: Table = {
    name: "field_usage",
    doc: "Fields each search reads, from its SPL: one row per field and matched sourcetype field (field_id is NULL when none matched).",
    columns: [
      col("entity_id"), col("field"), col("how", "TEXT", "Comma-separated: filter, groupBy, aggregate, eval, rename, lookup, extract, enrich, join, dedup, sort, select, output"),
      col("source", "TEXT", "events, datamodel, lookup, search, database, metrics or other"), col("field_id"),
    ],
    rows: per((e) => {
      const fl = e.lineage?.fields;
      if (!fl) return [];
      return fl.used.flatMap((u) => {
        const ids = fieldIds.get(`${e.id}|${u.name}`) ?? [undefined];
        return ids.map((fid) => [e.id, u.name, u.how.join(","), fl.source, fid].map(cell));
      });
    }),
  };

  const columnLineage: Table = {
    name: "column_lineage",
    doc: "Result columns of searches whose output shape is known, one row per source field they are computed from (source_field NULL for counts and constants).",
    columns: [col("entity_id"), col("column_name"), col("source_field")],
    rows: per((e) => (e.lineage?.fields?.outputs ?? []).flatMap((o) =>
      (o.from.length ? o.from : [undefined]).map((f) => [e.id, o.name, f].map(cell)))),
  };

  const riskTable: Table = {
    name: "risk",
    doc: "Objects at risk from upstream problems: one row per cause (the object with the problem).",
    columns: [
      col("entity_id"), col("severity", "TEXT", "warning or critical"), col("cause_id", "TEXT", "The object with the problem"),
      col("problem"), col("hops", "INTEGER", "1 = direct dependency"), col("via_id"),
      col("partial", "INTEGER", "1 if the cause is one of several sources"),
    ],
    rows: [...risk].flatMap(([id, r]) => r.causes.map((c) => [
      id, r.severity, c.root.id, c.problems.map((p) => p.summary).join("; "), c.depth, c.via?.id, c.partial ?? false,
    ].map(cell))),
  };

  return [entities, edges, labels, classifications, properties, settings, fieldsTable, healthChecks, lineageIssues,
    fieldUsage, columnLineage, riskTable, accessTable, instances, domains, dataProducts];
}

/** Create and fill an in-memory database. It is read-only once loaded. */
export function fillDatabase(db: Database, tables: Table[]) {
  db.run("BEGIN");
  for (const t of tables) {
    db.run(`CREATE TABLE ${t.name} (${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
    const stmt = db.prepare(`INSERT INTO ${t.name} VALUES (${t.columns.map(() => "?").join(", ")})`);
    for (const r of t.rows) stmt.run(r);
    stmt.free();
  }
  db.run("CREATE INDEX edges_from ON edges(from_id)");
  db.run("CREATE INDEX edges_to ON edges(to_id)");
  for (const t of ["labels", "classifications", "properties", "settings", "fields", "health_checks", "lineage_issues", "field_usage", "column_lineage", "risk", "access"]) {
    db.run(`CREATE INDEX ${t}_entity ON ${t}(entity_id)`);
  }
  db.run("COMMIT");
  db.run("PRAGMA query_only = 1");
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
  ms: number;
}

/** Run one or more statements; the last statement that returns rows is shown. */
export function runQuery(db: Database, sql: string): QueryResult {
  const start = performance.now();
  const results = db.exec(sql);
  const last = results[results.length - 1];
  return { columns: last?.columns ?? [], rows: last?.values ?? [], ms: performance.now() - start };
}

export interface Example {
  title: string;
  sql: string;
}

export const EXAMPLES: Example[] = [
  {
    title: "Searches scheduled every 15 minutes or more often",
    sql: `WITH s AS (
  SELECT id, name, app, json_extract(settings, '$.cronSchedule') AS cron
  FROM entities
  WHERE type IN ('savedSearch', 'correlationSearch') AND cron IS NOT NULL
), m AS (SELECT *, substr(cron, 1, instr(cron, ' ') - 1) AS minute FROM s)
SELECT id, name, app, cron
FROM m
WHERE minute = '*' OR (minute LIKE '*/%' AND CAST(substr(minute, 3) AS INTEGER) <= 15)
ORDER BY app, name;`,
  },
  {
    title: "Most depended-on objects",
    sql: `SELECT e.id, e.type, e.name, count(*) AS dependents
FROM edges x JOIN entities e ON e.id = x.to_id
WHERE x.type IN ('reads', 'uses', 'triggers')
GROUP BY e.id
ORDER BY dependents DESC
LIMIT 25;`,
  },
  {
    title: "Who alert emails go to",
    sql: `SELECT r.value AS recipient, j.key AS field, count(*) AS alerts,
       group_concat(e.name, ' | ') AS searches
FROM entities e,
     json_each(json_extract(e.settings, '$.alertRecipients')) j,
     json_each(CASE json_type(j.value) WHEN 'array' THEN j.value ELSE json_array(j.value) END) r
WHERE e.type IN ('savedSearch', 'correlationSearch', 'scheduledView') AND j.key != 'from'
GROUP BY recipient, field
ORDER BY alerts DESC, recipient;`,
  },
  {
    title: "Custom search commands and the searches that run them",
    sql: `SELECT c.app, c.name AS command, json_extract(c.settings, '$.protocol') AS protocol,
       count(s.id) AS used_by_count, group_concat(s.name, ' | ') AS used_by
FROM entities c
LEFT JOIN edges x ON x.to_id = c.id AND x.type = 'uses'
LEFT JOIN entities s ON s.id = x.from_id
WHERE c.type = 'searchCommand'
GROUP BY c.id
ORDER BY used_by_count DESC, c.app, c.name;`,
  },
  {
    title: "Alerts by how often they fire",
    sql: `SELECT name, app, type, alert_fires, alerts_suppressed, runs,
       json_extract(settings, '$.cronSchedule') AS schedule
FROM entities
WHERE alert_fires IS NOT NULL
ORDER BY alert_fires DESC, name;`,
  },
  {
    title: "Authentication tokens to review",
    sql: `SELECT e.display_name, json_extract(e.settings, '$.user') AS user,
       json_extract(e.settings, '$.expiresAt') AS expires,
       json_extract(e.settings, '$.lastUsed') AS last_used, h.check_name, h.status, h.message
FROM entities e JOIN health_checks h ON h.entity_id = e.id
WHERE e.type = 'authToken'
ORDER BY h.status = 'critical' DESC, e.display_name;`,
  },
  {
    title: "Index retention and storage",
    sql: `SELECT name, json_extract(settings, '$.retentionDays') AS retention_days,
       json_extract(settings, '$.maxTotalDataSizeMB') AS size_limit_mb,
       json_extract(settings, '$.observed.currentDBSizeMB') AS size_mb,
       json_extract(settings, '$.frozenAction') AS when_frozen,
       json_extract(settings, '$.storage.model') AS storage
FROM entities
WHERE type = 'index' AND disabled = 0
ORDER BY name;`,
  },
  {
    title: "Data dropped, rerouted or forwarded at index time",
    sql: `SELECT e.name AS sourcetype, json_extract(r.value, '$.rule') AS rule,
       json_extract(r.value, '$.transform') AS transform,
       coalesce(json_extract(r.value, '$.action'), json_extract(r.value, '$.actions')) AS what,
       json_extract(r.value, '$.targets') AS targets
FROM entities e, json_each(json_extract(e.settings, '$.indexTime')) r
WHERE e.type = 'sourcetype'
ORDER BY (what LIKE '%drop%') DESC, sourcetype;`,
  },
  {
    title: "Federated indexes and where their data lives",
    sql: `SELECT f.display_name AS federated_index, f.app,
       json_extract(f.settings, '$.provider') AS provider,
       json_extract(p.settings, '$.providerType') AS provider_type,
       json_extract(f.settings, '$.datasetType') || ':' || json_extract(f.settings, '$.dataset') AS remote_dataset,
       (SELECT count(*) FROM edges x WHERE x.to_id = f.id AND x.type = 'reads') AS searches
FROM entities f
LEFT JOIN entities p ON p.type = 'federatedProvider' AND p.instance = f.instance
     AND p.name = json_extract(f.settings, '$.provider')
WHERE f.type = 'federatedIndex'
ORDER BY f.display_name;`,
  },
  {
    title: "SPL2 modules, who can read them and what they read",
    sql: `SELECT m.app, m.name AS module, m.owner,
       m.read_roles AS readers,
       (SELECT group_concat(t.type || ':' || t.name, ', ') FROM edges x JOIN entities t ON t.id = x.to_id
         WHERE x.from_id = m.id AND x.type = 'reads') AS reads
FROM entities m
WHERE m.type = 'spl2Module'
ORDER BY m.app, m.name;`,
  },
  {
    title: "External datastores (Azure, AWS, Snowflake) and their connections",
    sql: `SELECT d.app, d.name AS datastore, json_extract(d.settings, '$.kind') AS kind,
       json_extract(d.settings, '$.dataSource') AS data_source,
       json_extract(d.settings, '$.connection') AS connection,
       json_extract(c.settings, '$.authMethods') AS auth,
       coalesce(json_extract(d.settings, '$.storageAccount'), json_extract(d.settings, '$.bucket')) AS account_or_bucket,
       json_extract(d.settings, '$.container') AS container,
       json_extract(d.settings, '$.directory') AS directory
FROM entities d
LEFT JOIN entities c ON c.type = 'spl2Connection' AND c.instance = d.instance
     AND c.name = json_extract(d.settings, '$.connection')
WHERE d.type = 'spl2Dataset'
ORDER BY data_source, d.app, d.name;`,
  },
  {
    title: "Detections muted, grouped or automated in ES",
    sql: `SELECT d.name AS detection, r.type AS rule_type, r.name AS rule, r.disabled,
       (SELECT group_concat(h.check_name, ', ') FROM health_checks h WHERE h.entity_id = r.id) AS issues
FROM edges x
JOIN entities r ON r.id = x.from_id
JOIN entities d ON d.id = x.to_id
WHERE d.type = 'correlationSearch' AND x.type = 'uses'
  AND r.type IN ('esSuppression', 'esAggregationRule', 'esAutomationRule')
ORDER BY d.name, r.type;`,
  },
  {
    title: "Detections with no annotated owner",
    sql: `SELECT id, name, app, health
FROM entities e
WHERE type = 'correlationSearch'
  AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.entity_id = e.id AND l.kind = 'owner')
ORDER BY name;`,
  },
  {
    title: "Sensitive data every role can read",
    sql: `SELECT e.id, e.type, group_concat(DISTINCT c.name) AS classifications
FROM entities e JOIN classifications c ON c.entity_id = e.id AND c.sensitive = 1
WHERE e.readable_by_everyone = 1
GROUP BY e.id;`,
  },
  {
    title: "Problems that put the most objects at risk",
    sql: `SELECT c.id, c.type, c.name, min(r.problem) AS problem, count(DISTINCT r.entity_id) AS at_risk
FROM risk r JOIN entities c ON c.id = r.cause_id
GROUP BY c.id
ORDER BY at_risk DESC;`,
  },
  {
    title: "Detections that break if a field disappears",
    sql: `SELECT u.field, count(DISTINCT u.entity_id) AS searches, group_concat(DISTINCT e.name) AS detections
FROM field_usage u JOIN entities e ON e.id = u.entity_id
WHERE e.type = 'correlationSearch'
GROUP BY u.field
ORDER BY searches DESC;`,
  },
  {
    title: "Fields missing from most events",
    sql: `SELECT sourcetype, field, round(fill_rate * 100, 1) AS filled_pct, distinct_values
FROM fields
WHERE fill_rate < 0.5
ORDER BY fill_rate, sourcetype;`,
  },
  {
    title: "Sourcetype fields nobody uses",
    sql: `SELECT f.id, f.name
FROM entities f
WHERE f.type = 'field'
  AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.to_id = f.id AND x.type = 'readsField')
ORDER BY f.name;`,
  },
  {
    title: "Unused objects by app",
    sql: `SELECT app, type, count(*) AS unused
FROM entities
WHERE unused = 1 AND coalesce(sharing, '') != 'system'
GROUP BY app, type
ORDER BY unused DESC;`,
  },
  {
    title: "Health findings by domain",
    sql: `SELECT coalesce(e.domain, '(none)') AS domain, h.status, count(*) AS findings
FROM health_checks h JOIN entities e ON e.id = h.entity_id
WHERE h.status != 'ok'
GROUP BY 1, 2
ORDER BY findings DESC;`,
  },
  {
    title: "Missing required properties by owner",
    sql: `SELECT coalesce(o.value, '(no owner)') AS owner, m.value AS property, count(*) AS objects
FROM labels m
LEFT JOIN labels o ON o.entity_id = m.entity_id AND o.kind = 'owner'
WHERE m.kind = 'missingProperty'
GROUP BY 1, 2
ORDER BY objects DESC;`,
  },
  {
    title: "Index sizes",
    sql: `SELECT e.name, e.instance, CAST(s.value AS REAL) AS size_mb
FROM entities e JOIN settings s ON s.entity_id = e.id AND s.key = 'observed.currentDBSizeMB'
WHERE e.type = 'index'
ORDER BY size_mb DESC;`,
  },
];
