import { Link } from "react-router-dom";
import type { EntityType } from "../generated/catalog";
import { CoverageReport } from "../components/CoverageReport";
import { PropValue } from "../components/PropValue";
import { effectiveDescription } from "../lib/annotate";
import { detectionStatus, isDetection } from "../lib/coverage";
import { riskMap } from "../lib/risk";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel, TYPE_GROUPS, typeGroup, typeLabel } from "../lib/labels";
import { entityPath, searchPath } from "../lib/routes";
import { recentIds } from "../lib/recent";

const KIND_LABELS: Record<string, string> = {
  splunkEnterprise: "Splunk Enterprise",
  splunkCloud: "Splunk Cloud",
  soar: "SOAR",
  uba: "UBA",
  deploymentServer: "Deployment Server",
};

const CHANGE_LIMIT = 15;

/** "3 days ago" from now (when a stack was built or imported). */
function agoText(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (Number.isNaN(days)) return "";
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/** A tiny trend line over builds (no axes: the tile's number is the latest value). */
function MiniTrend({ values, label }: { values: number[]; label: string }) {
  const w = 96, h = 22, max = Math.max(1, ...values), step = (w - 4) / (values.length - 1);
  const pts = values.map((v, i) => `${2 + i * step},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return (
    <svg className="mini-trend" width={w} height={h} role="img" aria-label={`${label}: ${values.join(", ")}`}>
      <polyline points={pts} />
    </svg>
  );
}

function ChangeList({ ids, label }: { ids: string[]; label: string }) {
  const { catalog } = useCatalog();
  if (!ids.length) return null;
  return (
    <div>
      <h3>{label} <span className="muted">({ids.length})</span></h3>
      <ul className="plain-list">
        {ids.slice(0, CHANGE_LIMIT).map((id) => {
          const e = catalog.byId.get(id);
          return (
            <li key={id}>
              {e ? (<><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(id)}>{e.displayName ?? e.name}</Link></>) : id}
            </li>
          );
        })}
        {ids.length > CHANGE_LIMIT && <li className="muted">…and {ids.length - CHANGE_LIMIT} more</li>}
      </ul>
    </div>
  );
}

export function Home() {
  const { catalog } = useCatalog();
  const { bundle } = catalog;
  const byType = [...catalog.countBy("type").entries()].sort((a, b) => b[1] - a[1]);
  const byProduct = [...catalog.countBy("product").entries()];
  const report = bundle.ingestionReport ?? [];
  const changes = bundle.changes;
  const total = bundle.entities.length || 1;
  const described = bundle.entities.filter((e) => effectiveDescription(e)).length;
  const owned = bundle.entities.filter((e) => e.annotations?.owners?.length).length;
  const classified = bundle.entities.filter((e) => e.annotations?.classifications?.length).length;
  const detections = bundle.entities.filter(isDetection).map((e) => detectionStatus(catalog, e));
  const firing = detections.filter((d) => d.state === "ready").length;
  const atRisk = riskMap(catalog).size;
  const missingRequired = bundle.entities.filter((e) => e.annotations?.missingProperties?.length).length;
  const broken = bundle.entities.filter((e) => e.lineage?.unresolved?.length).length;
  const healthReport = bundle.ingestionReport?.find((r) => r.connector === "health");
  const gov = bundle.ingestionReport?.find((r) => r.connector === "governance")?.counts;
  const unhealthy = bundle.entities.filter((e) => e.health);
  const unusedCustom = bundle.entities.filter((e) => e.usage?.unused && !e.usage.builtin).length;
  const noIndex = bundle.entities.filter((e) => e.lineage?.implicitIndex).length;
  const coverage: [string, number, string][] = [
    ["have a description", described, searchPath({ documented: "no" })],
    ["have an owner", owned, "/insights"],
    ["are classified", classified, "/governance"],
  ];
  const history = bundle.healthHistory ?? [];
  const critical = unhealthy.filter((e) => e.health!.status === "critical").length;
  const glance: { num: string; label: string; to: string; title?: string; tone?: "critical" | "warning"; trend?: number[] }[] = [
    ...(healthReport ? [
      { num: `${critical} / ${unhealthy.length - critical}`, label: "objects critical / with warnings", to: "/health", tone: critical ? "critical" as const : unhealthy.length ? "warning" as const : undefined,
        trend: history.map((h) => h.critical + h.warning), title: "Open the health report" },
      { num: unusedCustom.toLocaleString(), label: "unused objects in custom apps", to: "/health", title: "Cleanup report on the Health page", trend: history.some((h) => h.unused !== undefined) ? history.map((h) => h.unused ?? 0) : undefined },
    ] : []),
    ...(atRisk ? [{ num: atRisk.toLocaleString(), label: "at risk from upstream problems", to: searchPath({ risk: ["critical", "warning"] }), tone: "warning" as const }] : []),
    ...(detections.length ? [{ num: `${firing} / ${detections.length}`, label: "detections can fire", to: "/coverage", tone: firing < detections.length ? "warning" as const : undefined, title: "ATT&CK and CIM coverage" }] : []),
    ...(gov && gov.sensitiveStores > 0 ? [{ num: gov.sensitiveStores.toLocaleString(), label: `sensitive data stores${gov.exposedToEveryone ? `, ${gov.exposedToEveryone} readable by every role` : ""}`, to: "/governance", tone: gov.exposedToEveryone ? "warning" as const : undefined }] : []),
    ...(broken ? [{ num: broken.toLocaleString(), label: "objects with broken references", to: searchPath({ issue: "broken reference" }), tone: "warning" as const, title: "Macros, lookups, indexes or saved searches that are missing or not shared" }] : []),
    ...(noIndex ? [{ num: noIndex.toLocaleString(), label: "searches without an index", to: searchPath({ issue: "no index specified" }), title: "Results depend on the user's default indexes" }] : []),
    ...((bundle.structuredProperties?.length ?? 0) > 0 ? [{ num: missingRequired.toLocaleString(), label: "objects missing a required property", to: "/properties", tone: missingRequired ? "warning" as const : undefined }] : []),
    ...((bundle.domains?.length ?? 0) > 0 ? [{ num: `${bundle.domains!.length} / ${bundle.dataProducts?.length ?? 0}`, label: "domains / data products", to: "/domains" }] : []),
  ];
  const recent = recentIds().map((id) => catalog.byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e).slice(0, 10);
  // Objects and findings per instance (stack), for the instance cards.
  const perInstance = new Map<string, { objects: number; critical: number; warning: number }>();
  for (const e of bundle.entities) {
    const c = perInstance.get(e.instance) ?? { objects: 0, critical: 0, warning: 0 };
    c.objects++;
    if (e.health?.status === "critical") c.critical++;
    else if (e.health?.status === "warning") c.warning++;
    perInstance.set(e.instance, c);
  }
  const typeGroups = (() => {
    const by = new Map<string, [string, number][]>();
    for (const [t, n] of byType) by.set(typeGroup(t), [...(by.get(typeGroup(t)) ?? []), [t, n]]);
    return [...TYPE_GROUPS.map(([g]) => g), "Other"].filter((g) => by.has(g)).map((g) => [g, by.get(g)!] as const);
  })();

  return (
    <div className="stack">
      <section>
        <h1>Catalog overview</h1>
        <p className="lede">
          {bundle.entities.length.toLocaleString()} objects and {bundle.edges.length.toLocaleString()} relationships
          across {bundle.instances.length} instance{bundle.instances.length === 1 ? "" : "s"}.
        </p>
      </section>

      <section>
        <h2>Instances</h2>
        <div className="cards">
          {bundle.instances.map((i) => (
            <div key={i.id} className="card">
              <div className="card-title">{i.name}</div>
              <div className="muted">
                {KIND_LABELS[i.kind] ?? i.kind}
                {i.version && <> · {i.version}</>}
              </div>
              <p className="small stack-counts">
                <Link to={searchPath({ instance: i.id })}>{(perInstance.get(i.id)?.objects ?? 0).toLocaleString()} objects</Link>
                {healthReport && (perInstance.get(i.id)?.critical || perInstance.get(i.id)?.warning) ? (
                  <> · <Link to={`/health?instance=${encodeURIComponent(i.id)}`} className={perInstance.get(i.id)!.critical ? "status-label status-critical" : "status-label status-warning"}>
                    {perInstance.get(i.id)!.critical ? `${perInstance.get(i.id)!.critical} critical, ` : ""}{perInstance.get(i.id)!.warning} with warnings
                  </Link></>
                ) : null}
              </p>
              <p className="small muted">
                {i.imported
                  ? <>Imported {i.imported.at ? agoText(i.imported.at) : ""}{i.imported.by ? ` by ${i.imported.by}` : ""}{i.imported.from ? ` from ${i.imported.from.replace(/^(stack|file) /, "")}` : ""}</>
                  : <>Built here {agoText(bundle.generatedAt)}</>}
              </p>
              {i.roles?.length ? <p className="small">Roles: {i.roles.join(", ")}</p> : null}
              <HecSummary hec={(i.properties as Record<string, unknown> | undefined)?.httpEventCollector} />
              {i.properties && Object.keys(i.properties).length > 0 && (
                <details>
                  <summary>Details</summary>
                  <PropValue value={i.properties} />
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>At a glance</h2>
        <div className="tiles glance">
          {glance.map((t) => (
            <Link key={t.label} to={t.to} className={`tile${t.tone ? ` tile-${t.tone}` : ""}`} title={t.title}>
              <span className="tile-num">{t.num}</span>
              <span className="tile-label">{t.label}</span>
              {t.trend && t.trend.length > 1 && <MiniTrend values={t.trend} label={`${t.label} over the last ${t.trend.length} builds`} />}
            </Link>
          ))}
        </div>
      </section>

      {recent.length > 0 && (
        <section>
          <h2>Recently viewed</h2>
          <ul className="chips recent-list">
            {recent.map((e) => (
              <li key={e.id}>
                <Link to={entityPath(e.id)} className="chip" title={e.id}>
                  <span className="chip-kind">{typeLabel(e.type)}</span>{e.displayName ?? e.name}
                  {bundle.instances.length > 1 && <span className="muted small"> · {bundle.instances.find((i) => i.id === e.instance)?.name ?? e.instance}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Documentation</h2>
        <div className="tiles">
          {coverage.map(([label, n, to]) => (
            <Link key={label} to={to} className="tile" title="Show the objects that lack it">
              <span className="tile-num">{Math.round((n / total) * 100)}%</span>
              <span className="tile-label">{label} ({n.toLocaleString()})</span>
            </Link>
          ))}
        </div>
        <p className="small">
          <Link to={searchPath({ documented: "no" })}>Find objects without a description</Link> ·{" "}
          <Link to="/glossary">Glossary ({(bundle.glossary ?? []).length} terms)</Link>
        </p>
      </section>

      <section>
        <h2>Object types</h2>
        {typeGroups.map(([group, types]) => (
          <div key={group} className="type-group">
            <h3>{group} <span className="muted small">{types.reduce((n, [, c]) => n + c, 0).toLocaleString()}</span></h3>
            <div className="tiles tiles-compact">
              {types.map(([type, n]) => (
                <Link key={type} to={searchPath({ type })} className="tile">
                  <span className="tile-num">{n.toLocaleString()}</span>
                  <span className="tile-label">{pluralTypeLabel(type as EntityType)}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2>Products</h2>
        <ul className="plain-list">
          {byProduct.map(([product, n]) => (
            <li key={product}>
              <Link to={searchPath({ product })}>{PRODUCT_LABELS[product]}</Link> — {n.toLocaleString()} objects
            </li>
          ))}
        </ul>
      </section>

      {changes && (
        <section>
          <h2>Changes since {new Date(changes.previousGeneratedAt).toLocaleString()} <Link className="small" to="/changes">what changed</Link></h2>
          {changes.added.length + changes.modified.length + changes.removed.length === 0 ? (
            <p className="muted">No changes.</p>
          ) : (
            <div className="rel-grid">
              <ChangeList ids={changes.added} label="Added" />
              <ChangeList ids={changes.modified} label="Modified" />
              {changes.removed.length > 0 && (
                <div>
                  <h3>Removed <span className="muted">({changes.removed.length})</span></h3>
                  <ul className="plain-list">
                    {changes.removed.slice(0, CHANGE_LIMIT).map((r) => (
                      <li key={r.id}><span className="muted rel-type">{typeLabel(r.type)}</span> {r.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {report.length > 0 && (
        <section>
          <h2>What this catalog covers</h2>
          <CoverageReport bundle={bundle} />
        </section>
      )}
    </div>
  );
}

/** HTTP Event Collector on an instance: on or off, port, and requests with invalid tokens. */
function HecSummary({ hec }: { hec: unknown }) {
  if (!hec || typeof hec !== "object") return null;
  const h = hec as { enabled?: boolean; port?: number; ssl?: boolean; invalidTokenRequests?: number; usageWindow?: string };
  const invalid = h.invalidTokenRequests ?? 0;
  return (
    <p className="small">
      HTTP Event Collector:{" "}
      {h.enabled === false ? (
        <span className="status-label status-critical">✕ off</span>
      ) : (
        <>on{h.port ? `, port ${h.port}` : ""}{h.ssl === false ? " (no SSL)" : ""}</>
      )}
      {invalid > 0 && (
        <>
          {" "}
          · <span className="status-label status-warning">! {invalid.toLocaleString()} requests with an invalid token</span>
        </>
      )}
    </p>
  );
}
