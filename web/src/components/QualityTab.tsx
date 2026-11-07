import type { Entity } from "../generated/catalog";
import { parseSource } from "../lib/annotate";
import { Meter } from "./Meter";

const STATUS = {
  fail: { cls: "status-critical", icon: "✕", label: "Failed" },
  pass: { cls: "status-good", icon: "✓", label: "Passed" },
  unknown: { cls: "status-unknown", icon: "?", label: "Not measured" },
} as const;

const TEST_NAMES: Record<string, string> = {
  fresh: "Freshness",
  volume: "Volume",
  notNull: "Not null",
  distinctBetween: "Distinct values",
};

/** Data quality checks and their latest results. */
export function QualityTab({ entity }: { entity: Entity }) {
  const q = entity.quality;
  if (!q) return null;
  const judged = q.passed + q.failed;
  const order = { fail: 0, unknown: 1, pass: 2 } as const;
  const tests = [...q.tests].sort((a, b) => order[a.status] - order[b.status] || (a.field ?? "").localeCompare(b.field ?? ""));
  return (
    <div className="stack">
      <dl className="schema-strip">
        <div><dt>Checks passing</dt><dd>{judged ? <Meter value={q.passed} max={judged} label={`${q.passed} of ${judged}`} name="Checks passing" /> : "—"}</dd></div>
        <div><dt>Failing</dt><dd>{q.failed ? <span className="status-label status-critical">✕ {q.failed}</span> : <span className="status-label status-good">✓ none</span>}</dd></div>
        <div><dt>Not measured</dt><dd>{q.tests.length - judged}</dd></div>
      </dl>
      <p className="muted small">
        Evaluated when the catalog was built, from the sampled field profile and health measurements. Built-in checks cover freshness,
        volume and fields detections read; add more with <code>qualityChecks</code> in an annotation file.
      </p>
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr><th>Status</th><th>Check</th><th>Field</th><th>Expectation</th><th>Result</th><th>Defined by</th></tr></thead>
          <tbody>
            {tests.map((t, i) => {
              const s = STATUS[t.status];
              return (
                <tr key={i}>
                  <td><span className={`status-label ${s.cls}`}>{s.icon} {s.label}</span></td>
                  <td>{TEST_NAMES[t.test] ?? t.test}</td>
                  <td>{t.field ? <code>{t.field}</code> : <span className="muted">whole {entity.type}</span>}</td>
                  <td>{t.expectation}{t.why && <div className="muted small">{t.why}</div>}</td>
                  <td>{t.result}</td>
                  <td className="small">{t.source === "default" ? <span className="muted">built in</span> : <code>{parseSource(t.source).file}</code>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
