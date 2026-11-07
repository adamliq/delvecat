import { useState } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { HOW_LABELS, usedFields } from "../lib/fieldLineage";
import { effectiveClassifications } from "../lib/governance";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";

const COL_W = 210;
const GAP = 120;
const ROW_H = 30;
const HEAD_H = 34;
const PAD = 10;

/** Sensitive classification names (top level) for each column of an object. */
function classifiedColumns(e: Entity): { byColumn: Map<string, string[]>; whole: string[] } {
  const byColumn = new Map<string, string[]>();
  const whole: string[] = [];
  for (const c of effectiveClassifications(e).filter((x) => x.sensitive)) {
    const root = c.name.split(".")[0];
    if (!c.columns?.length) {
      if (!whole.includes(root)) whole.push(root);
      continue;
    }
    for (const col of c.columns) {
      const list = byColumn.get(col) ?? [];
      if (!list.includes(root)) list.push(root);
      byColumn.set(col, list);
    }
  }
  return { byColumn, whole };
}

interface Node {
  key: string;
  name: string;
  x: number;
  y: number;
  classes: string[];
  note?: string;
  muted?: boolean;
}

/**
 * Source fields -> result columns -> columns of what the search writes, with a
 * line from each result column to the fields it is computed from.
 */
export function ColumnLineage({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const [active, setActive] = useState<string | null>(null);
  const fl = entity.lineage?.fields;
  if (!fl?.outputs?.length) return null;
  const outputs = fl.outputs;

  // Which source fields are sensitive: from the matched field objects, or from the
  // classified columns of the data the search reads.
  const used = usedFields(catalog, entity);
  const reads = catalog.edgesFrom(entity.id).filter((x) => x.type === "reads").map((x) => catalog.byId.get(x.to)).filter((e): e is Entity => Boolean(e));
  const inputClasses = reads.map(classifiedColumns);
  const sourceClasses = (name: string) => {
    const out = new Set<string>();
    for (const u of used.filter((u) => u.name === name)) {
      for (const f of u.fields) for (const c of effectiveClassifications(f)) if (c.sensitive) out.add(c.name.split(".")[0]);
    }
    for (const ic of inputClasses) for (const c of ic.byColumn.get(name) ?? []) out.add(c);
    return [...out];
  };
  const wholeInput = [...new Set(inputClasses.flatMap((ic) => ic.whole))];

  const feeding = new Set(outputs.flatMap((o) => o.from));
  const sources = [...used.map((u) => u.name)].sort((a, b) => Number(feeding.has(b)) - Number(feeding.has(a)) || a.localeCompare(b));
  const howOf = new Map(used.map((u) => [u.name, u.how]));
  const targets = catalog.edgesFrom(entity.id).filter((x) => x.type === "writes").map((x) => catalog.byId.get(x.to)).filter((e): e is Entity => Boolean(e));

  const left: Node[] = sources.map((name, i) => ({
    key: `s:${name}`, name, x: PAD, y: HEAD_H + i * ROW_H, classes: sourceClasses(name),
    muted: !feeding.has(name), note: feeding.has(name) ? undefined : (howOf.get(name) ?? []).map((h) => HOW_LABELS[h]).join(", "),
  }));
  const carries = (o: (typeof outputs)[number]) => {
    if (o.masked) return [];
    const out = new Set<string>();
    for (const f of o.from) for (const c of sourceClasses(f)) out.add(c);
    if (o.from.length) for (const c of wholeInput) out.add(c);
    return [...out];
  };
  const mid: Node[] = outputs.map((o, i) => ({
    key: `o:${o.name}`, name: o.name, x: PAD + COL_W + GAP, y: HEAD_H + i * ROW_H, classes: carries(o),
    note: o.masked ? "masked: count or hash" : o.from.length === 0 ? "count / time / constant" : undefined,
  }));
  const right: { target: Entity; nodes: Node[] }[] = targets.map((t, ti) => {
    const cls = classifiedColumns(t);
    return {
      target: t,
      nodes: outputs.map((o, i) => ({
        key: `t${ti}:${o.name}`, name: o.name, x: PAD + 2 * (COL_W + GAP), y: HEAD_H + (ti * (outputs.length + 1) + i) * ROW_H,
        classes: [...new Set([...(cls.byColumn.get(o.name) ?? []), ...(o.from.length && !o.masked ? cls.whole : [])])],
      })),
    };
  });

  const rows = Math.max(left.length, mid.length, right.reduce((n, r) => n + r.nodes.length + 1, 0) - (right.length ? 1 : 0));
  const width = PAD * 2 + (right.length ? 3 : 2) * COL_W + (right.length ? 2 : 1) * GAP;
  const height = HEAD_H + rows * ROW_H + PAD;
  const at = (n: Node, side: "in" | "out") => ({ x: side === "out" ? n.x + COL_W : n.x, y: n.y + (ROW_H - 6) / 2 });
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = (b.x - a.x) / 2;
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };
  const leftBy = new Map(left.map((n) => [n.name, n]));
  const edges: { key: string; d: string; ends: string[]; masked: boolean }[] = [];
  outputs.forEach((o, i) => {
    for (const f of o.from) {
      const s = leftBy.get(f);
      if (s) edges.push({ key: `${s.key}>${mid[i].key}`, d: curve(at(s, "out"), at(mid[i], "in")), ends: [s.key, mid[i].key], masked: Boolean(o.masked) });
    }
    for (const r of right) {
      edges.push({ key: `${mid[i].key}>${r.nodes[i].key}`, d: curve(at(mid[i], "out"), at(r.nodes[i], "in")), ends: [mid[i].key, r.nodes[i].key], masked: false });
    }
  });
  // Hovering a node lights every path through it, upstream and downstream.
  const lit = new Set<string>();
  if (active) {
    const touch = (k: string) => edges.filter((e) => e.ends.includes(k));
    const seen = new Set([active]);
    const stack = [active];
    while (stack.length) {
      const k = stack.pop()!;
      for (const e of touch(k)) {
        lit.add(e.key);
        for (const end of e.ends) if (!seen.has(end)) { seen.add(end); stack.push(end); }
      }
    }
  }

  const NodeBox = ({ n }: { n: Node }) => (
    <div className={`col-node${n.muted ? " col-node-muted" : ""}${active === n.key ? " col-node-active" : ""}`}
      style={{ left: n.x, top: n.y, width: COL_W, height: ROW_H - 6 }}
      tabIndex={0} onMouseEnter={() => setActive(n.key)} onMouseLeave={() => setActive(null)}
      onFocus={() => setActive(n.key)} onBlur={() => setActive(null)}
      title={[n.name, n.note, n.classes.length ? `sensitive: ${n.classes.join(", ")}` : ""].filter(Boolean).join(" · ")}>
      <code className="col-node-name">{n.name}</code>
      {n.note && <span className="col-node-note">{n.note}</span>}
      {n.classes.map((c) => <span key={c} className="node-badge node-badge-sensitive">{c}</span>)}
    </div>
  );

  return (
    <section>
      <h2>Column lineage</h2>
      <p className="muted small">
        Each result column and the source fields it is computed from{targets.length ? ", and the columns it writes" : ""}.
        Hover or focus a column to follow it. Sensitive columns carry their classification; counts and hashes pass none on.
      </p>
      <div className="lineage-scroll col-lineage" role="img" aria-label={`Column lineage of ${entity.displayName ?? entity.name}`}>
        <div className="lineage-canvas" style={{ width, height }}>
          <svg width={width} height={height} className="lineage-svg" aria-hidden>
            {edges.map((e) => (
              <path key={e.key} d={e.d}
                className={`col-edge${e.masked ? " col-edge-masked" : ""}${active ? (lit.has(e.key) ? " col-edge-lit" : " col-edge-dim") : ""}`} />
            ))}
          </svg>
          <div className="col-head" style={{ left: PAD, width: COL_W }}>Source fields</div>
          <div className="col-head" style={{ left: PAD + COL_W + GAP, width: COL_W }}>Result columns</div>
          {left.map((n) => <NodeBox key={n.key} n={n} />)}
          {mid.map((n) => <NodeBox key={n.key} n={n} />)}
          {right.map((r, ti) => (
            <div key={r.target.id}>
              <div className="col-head" style={{ left: PAD + 2 * (COL_W + GAP), width: COL_W, top: ti === 0 ? 0 : r.nodes[0].y - HEAD_H + 6 }}>
                Writes to {typeLabel(r.target.type).toLowerCase()} <Link to={entityPath(r.target.id)}>{r.target.displayName ?? r.target.name}</Link>
              </div>
              {r.nodes.map((n) => <NodeBox key={n.key} n={n} />)}
            </div>
          ))}
        </div>
      </div>
      {wholeInput.length > 0 && (
        <p className="muted small">It reads data classified {wholeInput.join(", ")} as a whole, so every column computed from a field may hold it.</p>
      )}
      <details className="small">
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Result column</th><th>Computed from</th><th>Sensitive</th></tr></thead>
            <tbody>
              {mid.map((n, i) => (
                <tr key={n.key}><td><code>{n.name}</code></td><td>{outputs[i].from.join(", ") || "—"}{outputs[i].masked ? " (masked)" : ""}</td><td>{n.classes.join(", ") || "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
