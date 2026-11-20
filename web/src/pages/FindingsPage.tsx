import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DataTable, type Column } from "../components/DataTable";
import { useCatalog } from "../lib/CatalogContext";
import { checkTitle, filterFindings, findings, type Finding } from "../lib/findings";
import { typeGroup, typeLabel } from "../lib/labels";
import { StatusLabel } from "./HealthPage";

const entityPath = (id: string) => `/entity/${encodeURIComponent(id)}`;

/** Every warning and critical check in the catalog, in one list. */
export function FindingsPage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const all = useMemo(() => findings(catalog.entities), [catalog]);
  const f = {
    status: params.get("status") ?? "",
    check: params.get("check") ?? "",
    area: params.get("area") ?? "",
    app: params.get("app") ?? "",
    text: params.get("q") ?? "",
  };
  const shown = useMemo(() => filterFindings(all, f), [all, f.status, f.check, f.area, f.app, f.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key: string, value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
  const checks = uniq(all.map((x) => x.check)).sort((a, b) => checkTitle(a).localeCompare(checkTitle(b)));
  const areas = uniq(all.map((x) => typeGroup(x.entity.type)));
  const apps = uniq(all.map((x) => x.entity.app ?? "").filter(Boolean));
  const critical = all.filter((x) => x.status === "critical").length;
  const owner = (x: Finding) => x.entity.annotations?.owners?.join(", ") || x.entity.owner || "";

  const columns: Column<Finding>[] = [
    { label: "Severity", value: (x) => (x.status === "critical" ? 0 : 1), render: (x) => <StatusLabel status={x.status} /> },
    { label: "Finding", value: (x) => checkTitle(x.check) },
    {
      label: "Object",
      value: (x) => x.entity.displayName ?? x.entity.name,
      render: (x) => (
        <>
          <span className="muted rel-type">{typeLabel(x.entity.type)}</span>{" "}
          <Link to={entityPath(x.entity.id)}>{x.entity.displayName ?? x.entity.name}</Link>
        </>
      ),
    },
    { label: "Detail", value: (x) => x.message },
    { label: "App", value: (x) => x.entity.app ?? "" },
    { label: "Owner", value: owner },
    ...(catalog.bundle.instances.length > 1 ? [{ label: "Instance", value: (x: Finding) => x.entity.instance }] : []),
  ];

  return (
    <div className="stack">
      <div>
        <h1>Findings</h1>
        <p className="lede">
          Everything the catalog flagged, most severe first: data and scheduler problems, tokens, alerts, suppressions,
          routing, retention and acceleration. Each finding links to its object.
        </p>
      </div>
      <div className="tiles">
        <button type="button" className={`tile${f.status === "critical" ? " active" : ""}`} onClick={() => set("status", f.status === "critical" ? "" : "critical")}>
          <span className="tile-num">{critical}</span><span className="tile-label">critical</span>
        </button>
        <button type="button" className={`tile${f.status === "warning" ? " active" : ""}`} onClick={() => set("status", f.status === "warning" ? "" : "warning")}>
          <span className="tile-num">{all.length - critical}</span><span className="tile-label">warnings</span>
        </button>
        <div className="tile static"><span className="tile-num">{new Set(all.map((x) => x.entity.id)).size}</span><span className="tile-label">objects affected</span></div>
      </div>
      <div className="lineage-controls findings-filters">
        <label className="sort">Finding
          <select value={f.check} onChange={(e) => set("check", e.target.value)}>
            <option value="">All</option>
            {checks.map((c) => <option key={c} value={c}>{checkTitle(c)}</option>)}
          </select>
        </label>
        <label className="sort">Area
          <select value={f.area} onChange={(e) => set("area", e.target.value)}>
            <option value="">All</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="sort">App
          <select value={f.app} onChange={(e) => set("app", e.target.value)}>
            <option value="">All</option>
            {apps.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="sort">Contains
          <input type="search" value={f.text} placeholder="text, object or owner" onChange={(e) => set("q", e.target.value)} />
        </label>
      </div>
      <DataTable
        rows={shown}
        columns={columns}
        rowKey={(x) => `${x.entity.id}|${x.check}`}
        csvName="delvecat-findings.csv"
        empty={<p className="muted">{all.length ? "No finding matches these filters." : "Nothing flagged: every object passed its checks."}</p>}
      />
    </div>
  );
}
