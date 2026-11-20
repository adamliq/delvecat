import { useMemo, useState } from "react";
import { DataTable } from "../components/DataTable";
import { Link } from "react-router-dom";
import type { Entity, EntityType } from "../generated/catalog";
import { Sparkline } from "../components/Sparkline";
import { useCatalog } from "../lib/CatalogContext";
import { dailySeries, downloadText, healthStatus, isBuiltin, isUnused, toCsv } from "../lib/health";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { riskMap } from "../lib/risk";
import { entityPath } from "../lib/routes";

const ICON = { critical: "✕", warning: "!", ok: "✓" } as const;

/** "as of 2026-11-06T05:43:46Z" → "Measured as of 06/11/2026, 05:43." in the reader's locale. */
function asOf(message?: string): string {
  const iso = message?.replace(/^as of /, "");
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `Measured as of ${d.toLocaleString()}.` : "";
}

export function StatusLabel({ status }: { status: "ok" | "warning" | "critical" }) {
  const cls = status === "ok" ? "status-good" : status === "warning" ? "status-warning" : "status-critical";
  return <span className={`status-label ${cls}`}>{ICON[status]} {status === "ok" ? "OK" : status === "warning" ? "Warning" : "Critical"}</span>;
}

function IssueTable({ title, entities, empty, spark = false }: {
  title: string; entities: Entity[]; empty: string; spark?: boolean;
}) {
  const sorted = [...entities].sort((a, b) =>
    (healthStatus(b) === "critical" ? 1 : 0) - (healthStatus(a) === "critical" ? 1 : 0) || a.name.localeCompare(b.name));
  return (
    <section>
      <h2>{title} <span className="muted">({entities.length})</span></h2>
      <DataTable
        rows={sorted}
        rowKey={(e) => e.id}
        empty={<p className="muted">{empty}</p>}
        columns={[
          { label: "Object", value: (e) => e.displayName ?? e.name, render: (e) => (
            <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>
              {e.app && <div className="muted small">{e.app}</div>}</>
          ) },
          { label: "Status", value: (e) => (healthStatus(e) === "critical" ? 0 : 1), render: (e) => <StatusLabel status={healthStatus(e)} /> },
          { label: "Findings", value: (e) => e.health!.checks.map((c) => c.message).join("; "),
            render: (e) => e.health!.checks.map((c) => <div key={c.check}>{c.message}</div>) },
          ...(spark ? [{ label: "Daily events", noSort: true, value: () => "", render: (e: Entity) => {
            const series = dailySeries(e);
            return series ? <Sparkline series={series} label={`Daily events for ${e.name}`} /> : "—";
          } }] : []),
        ]}
      />
    </section>
  );
}

function AtRisk() {
  const { catalog } = useCatalog();
  const rows = [...riskMap(catalog)].map(([id, risk]) => ({ entity: catalog.byId.get(id)!, risk }))
    .filter((r) => r.entity)
    .sort((a, b) => (a.risk.severity === b.risk.severity ? 0 : a.risk.severity === "critical" ? -1 : 1)
      || a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
  const exportCsv = () => downloadText("delvecat-at-risk.csv", toCsv([
    ["type", "name", "app", "risk", "caused by", "problem", "hops", "via", "partly affected", "id"],
    ...rows.flatMap(({ entity: e, risk }) => risk.causes.map((c) => [
      e.type, e.name, e.app, risk.severity, c.root.id, c.problems.map((p) => p.summary).join("; "), c.depth, c.via?.id,
      c.partial ? "yes" : "no", e.id,
    ])),
  ]));
  return (
    <section>
      <div className="results-bar">
        <h2>At risk from upstream problems <span className="muted">({rows.length})</span></h2>
        <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!rows.length}>Download CSV</button>
      </div>
      <p className="muted small">
        Objects that depend, directly or through other objects, on something with a health finding, a broken reference or
        a disabled object. When something has several sources, one bad source only partly affects it.
      </p>
      <DataTable
        rows={rows}
        rowKey={(r) => r.entity.id}
        empty={<p className="muted">Nothing depends on an object with a problem.</p>}
        columns={[
          { label: "Object", value: ({ entity: e }) => e.displayName ?? e.name, render: ({ entity: e }) => (
            <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>
              {e.app && <div className="muted small">{e.app}</div>}</>
          ) },
          { label: "Risk", value: ({ risk }) => (risk.severity === "critical" ? 0 : 1), render: ({ risk }) => <StatusLabel status={risk.severity} /> },
          { label: "Caused by", value: ({ risk }) => risk.causes.map((c) => c.root.displayName ?? c.root.name).join("; "), render: ({ risk }) => risk.causes.map((c) => (
            <div key={c.root.id}>
              <Link to={entityPath(c.root.id)}>{c.root.displayName ?? c.root.name}</Link>: {c.problems.map((p) => p.summary).join("; ")}
              <span className="muted small"> · {c.depth === 1 ? "direct" : `${c.depth} hops`}{c.partial ? " · partly" : ""}</span>
            </div>
          )) },
        ]}
      />
    </section>
  );
}

export function HealthPage() {
  const { catalog } = useCatalog();
  const [builtin, setBuiltin] = useState(false);
  const [type, setType] = useState("");
  const report = catalog.bundle.ingestionReport?.find((r) => r.connector === "health");
  const withIssues = catalog.entities.filter((e) => e.health && healthStatus(e) !== "ok");
  const data = withIssues.filter((e) => e.type === "index" || e.type === "sourcetype");
  const searches = withIssues.filter((e) => e.type === "savedSearch" || e.type === "correlationSearch");
  const machines = withIssues.filter((e) => ["forwarder", "deploymentClient", "streamForwarder"].includes(e.type));
  const unusedAll = catalog.entities.filter(isUnused);
  const unused = useMemo(() => unusedAll.filter((e) => (builtin || !isBuiltin(e)) && (!type || e.type === type))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)), [unusedAll, builtin, type]);
  const types = [...new Set(unusedAll.filter((e) => builtin || !isBuiltin(e)).map((e) => e.type))].sort();
  const critical = withIssues.filter((e) => healthStatus(e) === "critical").length;

  if (!report) {
    return (
      <div className="stack">
        <h1>Health</h1>
        <p className="muted">This bundle has no usage or health data. Build it without <code>--no-usage</code> to include it.</p>
      </div>
    );
  }
  const exportCsv = () => downloadText("delvecat-unused-objects.csv", toCsv([
    ["type", "name", "app", "owner", "reason", "built-in", "id"],
    ...unused.map((e) => [e.type, e.name, e.app, e.owner, e.usage?.reason, e.usage?.builtin ? "yes" : "no", e.id]),
  ]));

  return (
    <div className="stack">
      <div>
        <h1>Health</h1>
        <p className="lede">Data freshness, volume, ingestion and scheduler problems, and objects nobody uses.</p>
        <p className="muted small">{asOf(report.message)} Thresholds: stale after 24 hours (critical after 7 days), volume below 30% or above 300% of the usual day, ingestion more than 10 minutes behind, more than 10% of scheduled runs skipped.</p>
      </div>
      <div className="tiles">
        <div className="tile static"><span className="tile-num">{critical}</span><span className="tile-label">critical</span></div>
        <div className="tile static"><span className="tile-num">{withIssues.length - critical}</span><span className="tile-label">warnings</span></div>
        <div className="tile static"><span className="tile-num">{data.length}</span><span className="tile-label">data sources with issues</span></div>
        <div className="tile static"><span className="tile-num">{searches.length}</span><span className="tile-label">searches with issues</span></div>
        <div className="tile static"><span className="tile-num">{unusedAll.filter((e) => !isBuiltin(e)).length}</span><span className="tile-label">unused objects (custom apps)</span></div>
      </div>

      <IssueTable title="Data sources" entities={data} empty="Every index and sourcetype looks healthy." spark />
      <IssueTable title="Scheduled searches and detections" entities={searches} empty="No skipped, failing or missing scheduled runs." />
      <IssueTable title="Forwarders and deployment clients" entities={machines} empty="Every forwarder and client reported recently." />

      <AtRisk />

      <section>
        <div className="results-bar">
          <h2>Cleanup: unused objects <span className="muted">({unused.length})</span></h2>
          <div className="lineage-controls">
            <label className="sort">
              Type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All types</option>
                {types.map((t) => <option key={t} value={t}>{pluralTypeLabel(t as EntityType)}</option>)}
              </select>
            </label>
            <label className="sort"><input type="checkbox" checked={builtin} onChange={(e) => setBuiltin(e.target.checked)} /> Include Splunk built-in apps</label>
            <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!unused.length}>Download CSV</button>
          </div>
        </div>
        <p className="muted small">
          Judged from the usage window of audit, scheduler and web logs, plus lineage: an object is unused when nothing in the
          catalog depends on it and no one ran, viewed or referenced it. Review before deleting anything.
        </p>
        <DataTable
          rows={unused}
          rowKey={(e) => e.id}
          empty={<p className="muted">Nothing unused{builtin ? "" : " in custom apps"}.</p>}
          columns={[
            { label: "Object", value: (e) => e.displayName ?? e.name, render: (e) => (
              <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link></>
            ) },
            { label: "Type", value: (e) => typeLabel(e.type) },
            { label: "App", value: (e) => e.app ?? "", render: (e) => <>{e.app ?? "—"}{e.usage?.builtin && <span className="muted small"> (built-in)</span>}</> },
            { label: "Why", value: (e) => e.usage?.reason ?? "" },
          ]}
        />
      </section>
    </div>
  );
}
