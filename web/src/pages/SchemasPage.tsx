import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { Meter } from "../components/Meter";
import { SchemaNetwork, type NetworkMode } from "../components/SchemaNetwork";
import type { Entity } from "../generated/catalog";
import { owners } from "../lib/annotate";
import { useCatalog } from "../lib/CatalogContext";
import { fieldName } from "../lib/fieldLineage";
import { termsOfField } from "../lib/glossaryFields";
import { effectiveClassifications } from "../lib/governance";
import { healthStatus } from "../lib/health";
import { entityPath } from "../lib/routes";
import { cimCoverage, schemaFields, schemaSourcetypes } from "../lib/schema";
import { columnsSource, lookupColumns, schemaLookups } from "../lib/lookups";
import { typeLabel } from "../lib/labels";
import { StatusLabel } from "./HealthPage";

export function SchemasPage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const models = params.getAll("dm");
  const owner = params.get("owner") ?? "";
  const minCim = Number(params.get("cim") ?? 0);
  const mode = (params.get("mode") as NetworkMode) || "fields";
  const minShared = Number(params.get("shared") ?? 3);
  const [qInput, setQInput] = useState(params.get("q") ?? "");
  const set = (k: string, v: string | string[] | null) => {
    const next = new URLSearchParams(params);
    next.delete(k);
    for (const x of v === null ? [] : Array.isArray(v) ? v : [v]) if (x !== "") next.append(k, x);
    setParams(next, { replace: true });
  };

  const all = useMemo(() => schemaSourcetypes(catalog).map((st) => {
    const fields = schemaFields(catalog, st);
    return {
      st, fields, cim: cimCoverage(catalog, st),
      sensitive: fields.filter((f) => effectiveClassifications(f).some((c) => c.sensitive)).length,
      owners: owners(st),
      terms: new Set(fields.flatMap((f) => termsOfField(catalog, f).map((t) => t.toLowerCase()))),
    };
  }), [catalog]);
  const allModels = [...new Set(all.flatMap((r) => r.cim.models.map((m) => m.name)))].sort();
  const allOwners = [...new Set(all.flatMap((r) => r.owners))].sort();
  const matches = (r: (typeof all)[number]) =>
    (!models.length || r.cim.models.some((m) => models.includes(m.name))) &&
    (!owner || r.owners.includes(owner)) &&
    (r.cim.pct ?? 0) >= minCim &&
    (!q || r.st.name.toLowerCase().includes(q) || r.fields.some((f) => fieldName(f).toLowerCase().includes(q)) || [...r.terms].some((t) => t.includes(q)));
  const rows = all.filter(matches);
  const lookups = useMemo(() => schemaLookups(catalog).map((e) => {
    const p = (e.properties ?? {}) as { kind?: string };
    return {
      e,
      columns: lookupColumns(e),
      kind: e.type === "kvCollection" ? "KV Store collection" : p.kind === "file" ? "file"
        : `${({ csv: "CSV", kvstore: "KV Store", external: "external", geo: "geo" } as Record<string, string>)[p.kind ?? ""] ?? "lookup"} definition`,
      users: new Set(catalog.edgesTo(e.id).filter((x) => ["reads", "writes", "uses"].includes(x.type)).map((x) => x.from)).size,
      owners: owners(e),
    };
  }), [catalog]);
  const lookupRows = lookups.filter((r) =>
    (!owner || r.owners.includes(owner)) &&
    (!q || r.e.name.toLowerCase().includes(q) || r.columns.some((c) => c.toLowerCase().includes(q))));
  const lookupHits = (r: (typeof lookups)[number]) => (q ? r.columns.filter((n) => n.toLowerCase().includes(q)).slice(0, 4) : []);
  const hits = (r: (typeof all)[number]) => (q ? r.fields.map(fieldName).filter((n) => n.toLowerCase().includes(q)).slice(0, 4) : []);

  return (
    <div className="stack">
      <div>
        <h1>Schemas</h1>
        <p className="lede">Field schemas of every sampled sourcetype, lookup and KV Store collection: how they map to data models, what they share, and where the same field differs.</p>
      </div>

      <div className="insights-filters schema-filters">
        <form role="search" onSubmit={(e) => { e.preventDefault(); set("q", qInput); }}>
          <input type="search" value={qInput} placeholder="Sourcetype, lookup, field or glossary term" aria-label="Search sourcetypes, lookups, fields and glossary terms"
            onChange={(e) => { setQInput(e.target.value); set("q", e.target.value); }} />
        </form>
        {allModels.length > 0 && (
          <div className="view-switch" role="group" aria-label="Data model">
            {allModels.map((m) => (
              <button key={m} type="button" className={`btn btn-small${models.includes(m) ? " btn-selected" : ""}`} aria-pressed={models.includes(m)}
                onClick={() => set("dm", models.includes(m) ? models.filter((x) => x !== m) : [...models, m])}>{m}</button>
            ))}
          </div>
        )}
        {allOwners.length > 0 && (
          <label className="sort">Owner
            <select value={owner} onChange={(e) => set("owner", e.target.value || null)}>
              <option value="">All owners</option>
              {allOwners.map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
        )}
        <label className="sort">Minimum CIM coverage
          <input type="range" min={0} max={100} step={10} value={minCim} onChange={(e) => set("cim", e.target.value === "0" ? null : e.target.value)} />
          <output>{minCim}%</output>
        </label>
        {(q || models.length || owner || minCim) ? <button type="button" className="link-btn" onClick={() => { setQInput(""); setParams(new URLSearchParams(), { replace: true }); }}>Clear filters</button> : null}
      </div>

      <section>
        <h2>Sourcetypes <span className="muted">({rows.length} of {all.length})</span></h2>
        {rows.length === 0 ? <p className="muted">No sourcetypes match. Loosen a filter or clear them all.</p> : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.st.id}
            csvName="delvecat-schemas.csv"
            columns={[
              { label: "Sourcetype", value: (r) => r.st.displayName ?? r.st.name, render: (r) => (
                <>
                  <Link to={`${entityPath(r.st.id)}?tab=fields`}>{r.st.displayName ?? r.st.name}</Link>
                  {hits(r).length > 0 && <div className="small">{hits(r).map((h) => <code key={h} className="hit">{h}</code>)}</div>}
                </>
              ) },
              { label: "Fields", value: (r) => r.fields.length },
              { label: "Data models", value: (r) => r.cim.models.map((m) => m.name).join(", "), render: (r) => (
                <>{r.cim.models.map((m: Entity, i: number) => <span key={m.id}>{i > 0 && ", "}<Link to={entityPath(m.id)}>{m.name}</Link></span>)}{!r.cim.models.length && <span className="muted">not mapped</span>}</>
              ) },
              { label: "CIM coverage", value: (r) => r.cim.pct ?? -1, render: (r) => (r.cim.pct === undefined ? <span className="muted">n/a</span> : <Meter value={r.cim.pct} max={100} label={`${r.cim.pct}%`} name={`CIM coverage of ${r.st.name}`} />) },
              { label: "Sensitive fields", value: (r) => r.sensitive },
              { label: "Owner", value: (r) => r.owners.join(", "), render: (r) => r.owners.join(", ") || <span className="muted">—</span> },
              { label: "Health", value: (r) => ({ critical: 0, warning: 1, ok: 2 })[healthStatus(r.st)], render: (r) => <StatusLabel status={healthStatus(r.st)} /> },
            ]}
          />
        )}
      </section>

      {lookups.length > 0 && (
        <section>
          <h2>Lookups and KV Store collections <span className="muted">({lookupRows.length} of {lookups.length})</span></h2>
          {lookupRows.length === 0 ? <p className="muted">No lookups match.</p> : (
            <DataTable
              rows={lookupRows}
              rowKey={(r) => r.e.id}
              csvName="delvecat-lookup-schemas.csv"
              columns={[
                { label: "Lookup", value: (r) => r.e.displayName ?? r.e.name, render: (r) => (
                  <>
                    <Link to={`${entityPath(r.e.id)}?tab=fields`}>{r.e.displayName ?? r.e.name}</Link>
                    {lookupHits(r).length > 0 && <div className="small">{lookupHits(r).map((h) => <code key={h} className="hit">{h}</code>)}</div>}
                  </>
                ) },
                { label: "Kind", value: (r) => r.kind, render: (r) => <span title={typeLabel(r.e.type)}>{r.kind}{columnsSource(r.e) === "header" && <span className="muted small"> · fields from its header row</span>}</span> },
                { label: "Fields", value: (r) => r.columns.length, render: (r) => <span title={r.columns.join(", ")}>{r.columns.length}</span> },
                { label: "App", value: (r) => r.e.app ?? "" },
                { label: "Used by", value: (r) => r.users, render: (r) => (r.users ? `${r.users} object${r.users === 1 ? "" : "s"}` : <span className="muted">nothing in the catalog</span>) },
                { label: "Owner", value: (r) => r.owners.join(", "), render: (r) => r.owners.join(", ") || <span className="muted">—</span> },
              ]}
            />
          )}
        </section>
      )}

      <section>
        <div className="results-bar">
          <h2>Shared fields</h2>
          <div className="lineage-controls">
            <div className="view-switch" role="group" aria-label="Graph mode">
              {([["fields", "Shared fields"], ["overlap", "Sourcetype overlap"]] as [NetworkMode, string][]).map(([m, label]) => (
                <button key={m} type="button" className={`btn btn-small${mode === m ? " btn-selected" : ""}`} aria-pressed={mode === m} onClick={() => set("mode", m === "fields" ? null : m)}>{label}</button>
              ))}
            </div>
            <label className="sort">Shared by at least
              <input type="range" min={2} max={8} value={minShared} onChange={(e) => set("shared", e.target.value === "3" ? null : e.target.value)} />
              <output>{minShared}</output>
            </label>
          </div>
        </div>
        <SchemaNetwork catalog={catalog} sourcetypes={rows.map((r) => r.st)} mode={mode} minShared={minShared} />
      </section>
    </div>
  );
}
