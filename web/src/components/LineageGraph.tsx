import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { Catalog } from "../lib/catalog";
import { typeLabel } from "../lib/labels";
import { lineageGraph } from "../lib/lineage";
import { entityPath } from "../lib/routes";

const NODE_W = 210;
const NODE_H = 46;
const COL_GAP = 80;
const ROW_GAP = 12;
const PAD = 12;
const MAX_PER_COLUMN = 30;

export function LineageGraph({ catalog, id, up, down }: { catalog: Catalog; id: string; up: number; down: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const graph = lineageGraph(catalog, id, up, down);
  useLayoutEffect(() => {
    // Keep the focused object in view when the graph is wider or taller than its box.
    const box = scroller.current;
    const focus = box?.querySelector<HTMLElement>(".lineage-node-focus");
    if (!box || !focus) return;
    box.scrollLeft = Math.max(0, focus.offsetLeft - (box.clientWidth - focus.offsetWidth) / 2);
    box.scrollTop = Math.max(0, focus.offsetTop - (box.clientHeight - focus.offsetHeight) / 2);
  }, [id, up, down]);
  const levels = [...new Set(graph.nodes.map((n) => n.level))].sort((a, b) => a - b);
  const columns = levels.map((level) =>
    graph.nodes
      .filter((n) => n.level === level)
      .sort((a, b) => a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name)),
  );
  const pos = new Map<string, { x: number; y: number }>();
  const hidden = new Map<number, number>();
  const tallest = Math.max(...columns.map((c) => Math.min(c.length, MAX_PER_COLUMN) + (c.length > MAX_PER_COLUMN ? 1 : 0)));
  const height = PAD * 2 + tallest * (NODE_H + ROW_GAP) - ROW_GAP;
  columns.forEach((col, ci) => {
    const shown = col.slice(0, MAX_PER_COLUMN);
    const rows = shown.length + (col.length > MAX_PER_COLUMN ? 1 : 0);
    const offset = (height - (rows * (NODE_H + ROW_GAP) - ROW_GAP)) / 2;
    shown.forEach((n, ri) => pos.set(n.entity.id, { x: PAD + ci * (NODE_W + COL_GAP), y: offset + ri * (NODE_H + ROW_GAP) }));
    if (col.length > MAX_PER_COLUMN) hidden.set(ci, col.length - MAX_PER_COLUMN);
  });
  const width = PAD * 2 + columns.length * (NODE_W + COL_GAP) - COL_GAP;

  const paths = graph.edges.flatMap((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return [];
    let d: string;
    if (a.x === b.x) {
      // Same column (e.g. an input that feeds both an index and a sourcetype): arc on the right.
      const x = a.x + NODE_W, y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2;
      const bulge = Math.min(COL_GAP - 16, 24 + Math.abs(y2 - y1) / 6);
      d = `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x + 2},${y2}`;
    } else if (b.x < a.x) {
      // Flows "backwards" across columns (possible with cycles): left side to right side.
      const x1 = a.x, y1 = a.y + NODE_H / 2, x2 = b.x + NODE_W, y2 = b.y + NODE_H / 2;
      d = `M${x1},${y1} C${x1 - 40},${y1} ${x2 + 40},${y2} ${x2},${y2}`;
    } else {
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
      const dx = Math.max(40, (x2 - x1) / 2);
      d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }
    const touches = e.from === id || e.to === id;
    return [
      <path key={`${e.from}|${e.to}|${e.type}`} d={d}
        className={`lineage-edge${touches ? " lineage-edge-focus" : ""}`} markerEnd="url(#arrow)">
        <title>{e.type}</title>
      </path>,
    ];
  });

  if (graph.nodes.length <= 1) return <p className="muted">No lineage found for this object.</p>;

  return (
    <div ref={scroller} className="lineage-scroll" role="img" aria-label="Lineage graph: upstream sources on the left, downstream consumers on the right">
      <div className="lineage-canvas" style={{ width, height }}>
        <svg width={width} height={height} className="lineage-svg" aria-hidden>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="lineage-arrow" />
            </marker>
          </defs>
          {paths}
        </svg>
        {graph.nodes.map(({ entity }) => {
          const p = pos.get(entity.id);
          if (!p) return null;
          const broken = Boolean(entity.lineage?.unresolved?.length);
          return (
            <Link key={entity.id} to={`${entityPath(entity.id)}?tab=lineage`}
              className={`lineage-node${entity.id === id ? " lineage-node-focus" : ""}${broken ? " lineage-node-broken" : ""}`}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              title={`${typeLabel(entity.type)}: ${entity.displayName ?? entity.name}${entity.app ? ` (${entity.app})` : ""}`}>
              <span className="lineage-node-type">{typeLabel(entity.type)}{broken ? " · broken ref" : ""}</span>
              <span className="lineage-node-name">{entity.displayName ?? entity.name}</span>
            </Link>
          );
        })}
        {[...hidden.entries()].map(([ci, n]) => (
          <div key={ci} className="lineage-more" style={{
            left: PAD + ci * (NODE_W + COL_GAP),
            top: (pos.get(columns[ci][MAX_PER_COLUMN - 1].entity.id)?.y ?? 0) + NODE_H + ROW_GAP,
            width: NODE_W, height: NODE_H }}>
            +{n} more
          </div>
        ))}
      </div>
      {(graph.hasMoreUp || graph.hasMoreDown) && (
        <p className="muted small">
          {graph.hasMoreUp && "More upstream objects beyond this depth. "}
          {graph.hasMoreDown && "More downstream objects beyond this depth."}
        </p>
      )}
    </div>
  );
}
