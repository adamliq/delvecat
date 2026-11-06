import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCatalog } from "../lib/CatalogContext";
import {
  coverage, dataModelCoverage, loadAttack, STATE_LABELS,
  type AttackData, type CellState, type DetectionStatus, type TechniqueCell,
} from "../lib/coverage";
import { entityPath } from "../lib/routes";

const CELL_ICON: Record<CellState, string> = { covered: "✓", weak: "!", none: "" };
const CELL_LABEL: Record<CellState, string> = {
  covered: "Covered by a detection that can fire",
  weak: "Detections exist but none can fire",
  none: "No detection",
};

function cellTitle(c: TechniqueCell): string {
  const lines = [`${c.id} ${c.name}`, CELL_LABEL[c.state]];
  for (const d of c.detections) lines.push(`• ${d.entity.displayName ?? d.entity.name} (${STATE_LABELS[d.state]})`);
  if (c.subtechniques) lines.push(`${c.subtechniques} sub-techniques rolled up`);
  return lines.join("\n");
}

function DetectionLink({ d }: { d: DetectionStatus }) {
  return <Link to={`${entityPath(d.entity.id)}?tab=lineage`}>{d.entity.displayName ?? d.entity.name}</Link>;
}

export function CoveragePage() {
  const { catalog } = useCatalog();
  const [attack, setAttack] = useState<AttackData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const show = (params.get("show") as "all" | "gaps" | "detected") || "all";
  const highlight = params.get("technique")?.toUpperCase().split(".")[0];

  useEffect(() => {
    loadAttack().then(setAttack).catch((e: Error) => setError(e.message));
  }, []);

  const cov = useMemo(() => (attack ? coverage(catalog, attack) : null), [catalog, attack]);
  const models = useMemo(() => (cov ? dataModelCoverage(catalog, cov.detections) : []), [catalog, cov]);

  if (error) return <div className="stack"><h1>Detection coverage</h1><p className="error">{error}</p></div>;
  if (!cov || !attack) return <p className="muted">Loading ATT&CK reference data…</p>;

  const ready = cov.detections.filter((d) => d.state === "ready");
  const blocked = cov.detections.filter((d) => d.state !== "ready");
  const emptyTactics = cov.columns.filter((c) => !c.cells.some((x) => x.state === "covered"));
  const setShow = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("show", v);
    setParams(next, { replace: true });
  };
  const visible = (c: TechniqueCell) =>
    show === "all" || (show === "gaps" ? c.state !== "covered" : c.state !== "none") || c.id === highlight;

  // Filtered views drop tactics with nothing to show, so the matrix stays readable.
  const shownColumns = show === "all" ? cov.columns : cov.columns.filter((c) => c.cells.some(visible));

  if (!cov.detections.length) {
    return (
      <div className="stack">
        <h1>Detection coverage</h1>
        <p className="muted">This bundle has no detections (Enterprise Security correlation searches or searches with ATT&CK annotations).</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Detection coverage</h1>
        <p className="lede">
          Which MITRE ATT&CK techniques and CIM data models your detections cover, and which detections cannot fire.
        </p>
      </div>

      <div className="tiles">
        <div className="tile static"><span className="tile-num">{cov.detections.length}</span><span className="tile-label">detections</span></div>
        <div className="tile static"><span className="tile-num">{ready.length}</span><span className="tile-label">can fire</span></div>
        <div className="tile static"><span className="tile-num">{blocked.length}</span><span className="tile-label">cannot fire</span></div>
        <div className="tile static">
          <span className="tile-num">{cov.topLevelCovered}<span className="tile-den"> / {cov.topLevelTotal}</span></span>
          <span className="tile-label">techniques covered</span>
        </div>
        <div className="tile static"><span className="tile-num">{emptyTactics.length}<span className="tile-den"> / {cov.columns.length}</span></span><span className="tile-label">tactics with no working detection</span></div>
      </div>

      {blocked.length > 0 && (
        <section>
          <h2>Detections that cannot fire</h2>
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Detection</th><th>Why</th><th>Techniques</th><th>Data models</th></tr></thead>
              <tbody>
                {blocked.map((d) => (
                  <tr key={d.entity.id}>
                    <td><DetectionLink d={d} /></td>
                    <td><span className="status-label status-warning">! {STATE_LABELS[d.state]}</span>
                      {d.entity.lineage?.unresolved?.length ? <div className="muted small">{d.entity.lineage.unresolved.join(", ")}</div> : null}</td>
                    <td>{d.techniques.join(", ") || "—"}</td>
                    <td>{d.dataModels.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <div className="results-bar">
          <h2>MITRE ATT&CK Enterprise {attack.version ? `v${attack.version}` : ""}</h2>
          <label className="sort">
            Show
            <select value={show} onChange={(e) => setShow(e.target.value)}>
              <option value="all">All techniques</option>
              <option value="detected">Techniques with detections</option>
              <option value="gaps">Gaps (not covered)</option>
            </select>
          </label>
        </div>
        <ul className="legend" aria-label="Legend">
          {(["covered", "weak", "none"] as CellState[]).map((s) => (
            <li key={s}><span className={`cell-swatch cell-${s}`} aria-hidden>{CELL_ICON[s]}</span>{CELL_LABEL[s]}</li>
          ))}
        </ul>
        {shownColumns.length === 0 && <p className="muted">Nothing to show for this filter.</p>}
        <div className="attack-scroll" hidden={shownColumns.length === 0}>
          <div className="attack-matrix" style={{ gridTemplateColumns: `repeat(${shownColumns.length}, minmax(132px, 1fr))` }}>
            {shownColumns.map(({ tactic, cells }) => {
              const covered = cells.filter((c) => c.state === "covered").length;
              return (
                <div key={tactic.id} className="attack-col">
                  <div className="attack-tactic" title={tactic.id}>
                    <span>{tactic.name}</span>
                    <span className="muted small">{covered} / {cells.length}</span>
                  </div>
                  {cells.filter(visible).map((c) => (
                    <a key={c.id} href={`https://attack.mitre.org/techniques/${c.id}/`} target="_blank" rel="noreferrer"
                      className={`attack-cell cell-${c.state}${c.id === highlight ? " cell-highlight" : ""}`} title={cellTitle(c)}>
                      <span className="attack-cell-name">{c.name}</span>
                      <span className="attack-cell-meta">
                        <span className="muted">{c.id}</span>
                        {c.detections.length > 0 && <span className="attack-count">{CELL_ICON[c.state]} {c.detections.length}</span>}
                      </span>
                    </a>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        {cov.unknownTechniques.length > 0 && (
          <p className="muted small">Not in this ATT&CK version (renamed or retired): {cov.unknownTechniques.join(", ")}</p>
        )}
      </section>

      {models.length > 0 && (
        <section>
          <h2>CIM data models used by detections</h2>
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Data model</th><th>In catalog</th><th>Data flowing in</th><th>Accelerated</th><th>Detections</th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td>{m.entity ? <Link to={`${entityPath(m.entity.id)}?tab=lineage`}>{m.name}</Link> : m.name}</td>
                    <td>{m.entity ? "Yes" : <span className="status-label status-warning">! Missing</span>}</td>
                    <td>{m.hasData ? <span className="status-label status-good">✓ Yes</span> : <span className="status-label status-warning">! No</span>}</td>
                    <td>{m.accelerated ? "Yes" : "No"}</td>
                    <td>{m.detections.map((d, i) => <span key={d.entity.id}>{i > 0 && ", "}<DetectionLink d={d} /></span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="muted small">{attack.attribution}</p>
    </div>
  );
}
