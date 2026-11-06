import { useState } from "react";
import { Link } from "react-router-dom";
import type { Entity, EntityType } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { impact, upstreamOf } from "../lib/lineage";
import { entityPath } from "../lib/routes";
import { LineageGraph } from "./LineageGraph";

const SUMMARY_LIMIT = 12;

function TypeSummary({ title, entities, empty }: { title: string; entities: Entity[]; empty: string }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<EntityType, number>();
  entities.forEach((e) => counts.set(e.type, (counts.get(e.type) ?? 0) + 1));
  const sorted = [...entities].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return (
    <div className="rel-group">
      <h3>{title} <span className="muted">({entities.length})</span></h3>
      {entities.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <>
          <p className="small">
            {[...counts.entries()].map(([t, n]) => `${n} ${n === 1 ? typeLabel(t) : pluralTypeLabel(t)}`).join(", ")}
          </p>
          <ul className="plain-list">
            {(open ? sorted : sorted.slice(0, SUMMARY_LIMIT)).map((e) => (
              <li key={e.id}>
                <span className="muted rel-type">{typeLabel(e.type)}</span>{" "}
                <Link to={`${entityPath(e.id)}?tab=lineage`}>{e.displayName ?? e.name}</Link>
                {e.app && <span className="muted"> · {e.app}</span>}
              </li>
            ))}
          </ul>
          {entities.length > SUMMARY_LIMIT && (
            <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
              {open ? "Show fewer" : `Show all ${entities.length}`}
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
  const downstream = impact(catalog, entity.id);
  const upstream = upstreamOf(catalog, entity.id);

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

      <section className="rel-grid">
        <TypeSummary title="Depends on (all upstream)" entities={upstream} empty="Nothing upstream." />
        <TypeSummary title="Impact (all downstream)" entities={downstream}
          empty="Nothing in the catalog depends on this object." />
      </section>
    </div>
  );
}
