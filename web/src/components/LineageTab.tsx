import { SourcetypeFieldLineage } from "./SourcetypeFieldLineage";
import { ColumnLineage } from "./ColumnLineage";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Entity, EntityType } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { downloadText, toCsv } from "../lib/health";
import { reach } from "../lib/lineage";
import { entityPath } from "../lib/routes";
import { LineageGraph } from "./LineageGraph";

const SUMMARY_LIMIT = 12;

const MAX_DEPTH_OPTIONS = [1, 2, 3, 5, 20];

/** Upstream or downstream objects with type and depth filters and a CSV export. */
function ReachList({ title, entity, direction, catalog, empty }: {
  title: string; entity: Entity; direction: "up" | "down"; catalog: Catalog; empty: string;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [depth, setDepth] = useState(20);
  const all = useMemo(() => reach(catalog, entity.id, direction), [catalog, entity.id, direction]);
  const shown = all.filter((r) => (!type || r.entity.type === type) && r.depth <= depth);
  const counts = new Map<EntityType, number>();
  shown.forEach((r) => counts.set(r.entity.type, (counts.get(r.entity.type) ?? 0) + 1));
  const types = [...new Set(all.map((r) => r.entity.type))].sort();

  const exportCsv = () => {
    const rows = shown.map((r) => [
      r.depth, typeLabel(r.entity.type), r.entity.displayName ?? r.entity.name, r.entity.app,
      r.entity.instance, r.entity.annotations?.domain, (r.entity.annotations?.owners ?? []).join("; "),
      r.entity.health?.status ?? "ok", r.via ? r.via.displayName ?? r.via.name : entity.displayName ?? entity.name,
      r.entity.id,
    ]);
    const header = ["hops", "type", "name", "app", "instance", "domain", "owners", "health", "reached via", "id"];
    const safe = (entity.displayName ?? entity.name).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
    downloadText(`${direction === "down" ? "impact" : "upstream"}-${safe}.csv`, toCsv([header, ...rows]));
  };

  return (
    <div className="rel-group">
      <h3>{title} <span className="muted">({shown.length}{shown.length !== all.length ? ` of ${all.length}` : ""})</span></h3>
      {all.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <>
          <div className="reach-controls">
            <label className="sort">
              Type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All</option>
                {types.map((t) => <option key={t} value={t}>{pluralTypeLabel(t)}</option>)}
              </select>
            </label>
            <label className="sort">
              Within
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                {MAX_DEPTH_OPTIONS.map((d) => <option key={d} value={d}>{d === 20 ? "any distance" : `${d} hop${d > 1 ? "s" : ""}`}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!shown.length}>Download CSV</button>
          </div>
          <p className="small">
            {[...counts.entries()].map(([t, n]) => `${n} ${n === 1 ? typeLabel(t) : pluralTypeLabel(t)}`).join(", ")}
          </p>
          <ul className="plain-list">
            {(open ? shown : shown.slice(0, SUMMARY_LIMIT)).map((r) => (
              <li key={r.entity.id}>
                <span className="muted rel-type">{typeLabel(r.entity.type)}</span>{" "}
                <Link to={`${entityPath(r.entity.id)}?tab=lineage`}>{r.entity.displayName ?? r.entity.name}</Link>
                <span className="muted small"> · {r.depth} hop{r.depth > 1 ? "s" : ""}{r.via ? ` via ${r.via.displayName ?? r.via.name}` : ""}</span>
              </li>
            ))}
          </ul>
          {shown.length > SUMMARY_LIMIT && (
            <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
              {open ? "Show fewer" : `Show all ${shown.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Depth({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="sort">
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "none" : `${n} hop${n > 1 ? "s" : ""}`}</option>)}
      </select>
    </label>
  );
}

export function LineageTab({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const [up, setUp] = useState(2);
  const [down, setDown] = useState(2);
  const l = entity.lineage;

  return (
    <div className="stack">
      {l && (l.unresolved?.length || l.warnings?.length || l.implicitIndex || l.dynamic) ? (
        <section className="notice">
          <h2>Search diagnostics</h2>
          {l.unresolved?.length ? (
            <p>
              <strong>References not found in the catalog:</strong>{" "}
              {l.unresolved.map((u) => <code key={u} className="chip">{u}</code>)}
              <br />
              <span className="muted small">
                The object may have been deleted, renamed, never existed, or is not shared with this app.
              </span>
            </p>
          ) : null}
          {l.implicitIndex && (
            <p>
              <strong>No index specified.</strong>{" "}
              <span className="muted small">Splunk searches each user's default indexes, so results depend on who runs it.</span>
            </p>
          )}
          {l.dynamic && (
            <p className="muted small">Uses <code>$tokens$</code>: some references are only known when the dashboard runs.</p>
          )}
          {l.warnings?.length ? (
            <ul className="plain-list small">{l.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          ) : null}
        </section>
      ) : null}

      <section>
        <div className="results-bar">
          <h2>Lineage</h2>
          <div className="lineage-controls">
            <Depth label="Upstream" value={up} onChange={setUp} />
            <Depth label="Downstream" value={down} onChange={setDown} />
          </div>
        </div>
        <p className="muted small">Sources on the left, consumers on the right. Select an object to follow its lineage.</p>
        <LineageGraph catalog={catalog} id={entity.id} up={up} down={down} />
      </section>

      <ColumnLineage catalog={catalog} entity={entity} />

      {entity.type === "sourcetype" && <SourcetypeFieldLineage catalog={catalog} entity={entity} />}

      <section className="rel-grid">
        <ReachList title="Depends on (upstream)" entity={entity} direction="up" catalog={catalog}
          empty="Nothing upstream." />
        <ReachList title="Impact (downstream)" entity={entity} direction="down" catalog={catalog}
          empty="Nothing in the catalog depends on this object." />
      </section>
    </div>
  );
}
