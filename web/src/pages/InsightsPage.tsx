import { DataTable } from "../components/DataTable";
import { commandInventory } from "../lib/commands";
import type { Catalog } from "../lib/catalog";
import { useMemo } from "react";
import { flag, useUrlState } from "../lib/urlState";
import { Link } from "react-router-dom";
import { FieldClassification, KpiTiles, OwnersChart, PropertyDistributions } from "../components/InsightsExtras";
import { Meter } from "../components/Meter";
import { useCatalog } from "../lib/CatalogContext";
import { coverageBy, METRICS, mostUsed, USAGE_GROUPS, type Coverage, type GroupBy } from "../lib/insights";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import type { EntityType } from "../generated/catalog";
import { commandPath, domainPath, entityPath, searchPath } from "../lib/routes";

const pct = ([ok, of]: [number, number]) => (of ? Math.round((100 * ok) / of) : undefined);

function groupLink(by: GroupBy, group: string, instanceName?: (id: string) => string) {
  if (group.startsWith("(")) return <span className="muted">{group}</span>;
  if (by === "instance") return <Link to={searchPath({ instance: group })}>{instanceName?.(group) ?? group}</Link>;
  if (by === "domain") return <Link to={domainPath(group)}>{group}</Link>;
  if (by === "type") return <Link to={searchPath({ type: group })}>{pluralTypeLabel(group as EntityType)}</Link>;
  return <Link to={searchPath({ app: group })}>{group}</Link>;
}

function CoverageCell({ c, metric, name }: { c: Coverage; metric: (typeof METRICS)[number]; name: string }) {
  const [ok, of] = c.counts[metric.key];
  const p = pct([ok, of]);
  if (p === undefined) return <span className="muted">n/a</span>;
  return <Meter value={p} max={100} label={`${p}%`} name={`${metric.label}, ${name}: ${ok} of ${of}`} />;
}

function CommandInventory({ catalog }: { catalog: Catalog }) {
  const rows = commandInventory(catalog);
  if (!rows.length) return null;
  return (
    <section>
      <h2>Commands</h2>
      <p className="muted small">Every command the catalog's searches run (saved searches, detections, dashboards, ad-hoc searches), built-in and custom. ! marks commands that delete data, run programs or a search per result, or send data out.</p>
      <DataTable
        rows={rows}
        rowKey={(r) => r.name}
        csvName="delvecat-commands.csv"
        limit={50}
        columns={[
          { label: "Command", value: (r) => r.name, render: (r) => <><Link to={commandPath(r.name)}><code>{r.name}</code></Link>{r.risk && <> <span className="status-label status-warning" title={r.risk}>! risky</span></>}</> },
          { label: "Kind", value: (r) => (r.custom ? "custom" : "built-in"), render: (r) => (r.custom ? <Link to={entityPath(r.custom.id)}>custom ({r.custom.app})</Link> : "built-in") },
          { label: "Searches running it", value: (r) => r.searches },
          { label: "Enabled", value: (r) => r.enabled },
          ...(catalog.bundle.instances.length > 1 ? [{ label: "Stacks", value: (r: (typeof rows)[number]) => r.stacks.size }] : []),
          { label: "Why risky", value: (r) => r.risk ?? "", render: (r) => r.risk ?? <span className="muted">—</span> },
        ]}
      />
    </section>
  );
}

export function InsightsPage() {
  const { catalog } = useCatalog();
  const [params, update] = useUrlState();
  const by = (["app", "domain", "type", "instance"].includes(params.get("by") ?? "") ? params.get("by") : "app") as GroupBy;
  const vendor = flag(params, "vendor");
  const setBy = (v: GroupBy) => update({ by: v === "app" ? undefined : v });
  const setVendor = (v: boolean) => update({ vendor: v });
  const { overall, groups } = useMemo(() => coverageBy(catalog, by, vendor), [catalog, by, vendor]);
  const usage = USAGE_GROUPS.map((g) => ({ ...g, top: mostUsed(catalog, g.types) })).filter((g) => g.top.length);

  return (
    <div className="stack">
      <div>
        <h1>Insights</h1>
        <p className="lede">How well the catalog is documented and owned, and what people actually use.</p>
      </div>

      <div className="insights-filters">
        <label className="sort">
          Group by
          <select value={by} onChange={(e) => setBy(e.target.value as GroupBy)}>
            <option value="app">App</option>
            <option value="domain">Domain</option>
            <option value="type">Type</option>
            {catalog.bundle.instances.length > 1 && <option value="instance">Stack</option>}
          </select>
        </label>
        <label className="sort"><input type="checkbox" checked={vendor} onChange={(e) => setVendor(e.target.checked)} /> Include Splunk and product apps</label>
      </div>

      <section>
        <h2>Targets</h2>
        <KpiTiles catalog={catalog} includeVendor={vendor} open={params.get("target") ?? undefined} onOpen={(k) => update({ target: k })} />
      </section>

      <section>
        <h2>Fields by classification</h2>
        <p className="muted small">Every sampled or configured sourcetype field, by its sensitive classification.</p>
        <FieldClassification catalog={catalog} />
      </section>

      <section>
        <h2>Distribution</h2>
        <div className="usage-grid">
          <PropertyDistributions catalog={catalog} />
          <OwnersChart catalog={catalog} includeVendor={vendor} />
        </div>
      </section>

      <section>
        <h2>Catalog coverage</h2>
        <div className="tiles">
          {METRICS.map((m) => {
            const p = pct(overall.counts[m.key]);
            return (
              <div key={m.key} className="tile static">
                <span className="tile-num">{p === undefined ? "n/a" : `${p}%`}</span>
                <span className="tile-label">{m.label.toLowerCase()} <span className="muted">({overall.counts[m.key][0].toLocaleString()} of {overall.counts[m.key][1].toLocaleString()})</span></span>
              </div>
            );
          })}
        </div>
        <p className="muted small">
          {overall.total.toLocaleString()} indexes, sourcetypes, searches, dashboards, lookups, macros, data models and other documented types
          {vendor ? "" : " in custom apps"}. "Required properties" counts objects that some required structured property applies to.
        </p>
        <div className="table-wrap">
          <table className="mini-table coverage-table">
            <thead>
              <tr><th>{by === "app" ? "App" : by === "domain" ? "Domain" : by === "instance" ? "Stack" : "Type"}</th><th>Objects</th>{METRICS.map((m) => <th key={m.key}>{m.label}</th>)}</tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group}>
                  <td>{groupLink(by, g.group, (id) => catalog.bundle.instances.find((i) => i.id === id)?.name ?? id)}</td>
                  <td className="num">{g.total.toLocaleString()}</td>
                  {METRICS.map((m) => <td key={m.key}><CoverageCell c={g} metric={m} name={g.group} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Most used</h2>
        {usage.length === 0 ? (
          <p className="muted">This bundle has no usage data. Build it without <code>--no-usage</code> to include it.</p>
        ) : (
          <div className="usage-grid">
            {usage.map((g) => {
              const max = g.top[0].score;
              return (
                <figure key={g.label} className="rank-chart">
                  <figcaption><strong>{g.label}</strong> <span className="muted small">by {g.measure}</span></figcaption>
                  <ol className="rank-list">
                    {g.top.map(({ entity, score }) => (
                      <li key={entity.id} className="rank-row" title={`${typeLabel(entity.type)} ${entity.displayName ?? entity.name}: ${score.toLocaleString()} ${g.measure}`}>
                        <Link to={entityPath(entity.id)} className={`rank-name${entity.type === "adhocSearch" ? " spl-title" : ""}`}>{entity.displayName ?? entity.name}</Link>
                        <span className="rank-bar-track">
                          <span className="rank-bar" style={{ width: `calc((100% - 4em) * ${Math.max(0.02, score / max)})` }} />
                          <span className="rank-value">{score.toLocaleString()}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </figure>
              );
            })}
          </div>
        )}
      </section>

      <CommandInventory catalog={catalog} />
    </div>
  );
}
