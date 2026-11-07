import type { Database, SqlValue } from "sql.js";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { effectiveDescription } from "./annotate";
import { access, effectiveClassifications, isSensitive } from "./governance";

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

export function catalogTables(bundle: CatalogBundle): Table[] {
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
      col("unused", "INTEGER", "1 if no recorded use"),
      col("runs", "INTEGER"), col("searches", "INTEGER"), col("views", "INTEGER"),
      col("last_used"), col("updated_at"), col("first_seen_at"), col("version", "INTEGER"),
      col("url", "TEXT", "Link to the object in Splunk"),
      col("settings", "TEXT", "Splunk settings as JSON; use json_extract(settings, '$.cronSchedule')"),
      col("props", "TEXT", "Structured property values as JSON"),
    ],
    rows: E.map((e) => [
      e.id, e.type, e.name, e.displayName, e.product, e.instance, e.app, e.owner, e.sharing, e.disabled ?? false,
      effectiveDescription(e), e.annotations?.domain, e.health?.status, isSensitive(e), access(e)?.everyone,
      e.usage?.unused, e.usage?.runs, e.usage?.searches, e.usage?.views, e.usage?.lastUsed,
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
    columns: [col("entity_id"), col("name"), col("sensitive", "INTEGER"), col("how", "TEXT", "annotated, field, sourcetype or lineage"), col("via")],
    rows: per((e) => effectiveClassifications(e).map((c) => [e.id, c.name, c.sensitive, c.how, c.via].map(cell))),
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
    doc: "Splunk settings, one row per key (nested 'observed' values as observed.<key>).",
    columns: [col("entity_id"), col("key"), col("value")],
    rows: per((e) =>
      Object.entries(e.properties ?? {}).flatMap(([k, v]) =>
        k === "observed" && v && typeof v === "object" && !Array.isArray(v)
          ? Object.entries(v).map(([k2, v2]) => [e.id, `observed.${k2}`, v2 as Cell].map(cell))
          : [[e.id, k, v as Cell].map(cell)])),
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

  return [entities, edges, labels, classifications, properties, settings, healthChecks, lineageIssues,
    accessTable, instances, domains, dataProducts];
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
  for (const t of ["labels", "classifications", "properties", "settings", "health_checks", "lineage_issues", "access"]) {
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
