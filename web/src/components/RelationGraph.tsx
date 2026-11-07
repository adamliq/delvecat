import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { typeLabel } from "../lib/labels";
import { badges } from "../lib/overlays";
import type { RelationGroup } from "../lib/relations";
import { entityPath } from "../lib/routes";

const NODE_W = 210;
const NODE_H = 46;
const GAP_X = 120;
const ROW = NODE_H + 8;
const HEAD = 26;
const GROUP_GAP = 14;
const PAD = 12;
const PER_GROUP = 8;

interface Placed {
  entity: Entity;
  x: number;
  y: number;
}

interface Column {
  heads: { label: string; y: number; more: number }[];
  nodes: Placed[];
  height: number;
}

function layout(groups: RelationGroup[], x: number): Column {
  const heads: Column["heads"] = [];
  const nodes: Placed[] = [];
  let y = PAD;
  for (const g of groups) {
    const shown = g.entities.slice(0, PER_GROUP);
    heads.push({ label: `${g.label} (${g.entities.length})`, y, more: g.entities.length - shown.length });
    y += HEAD;
    for (const e of shown) {
      nodes.push({ entity: e, x, y });
      y += ROW;
    }
    if (g.entities.length > shown.length) y += 22;
    y += GROUP_GAP;
  }
  return { heads, nodes, height: y };
}

/** Every relationship of an object, one hop: incoming on the left, outgoing on the right. */
export function RelationGraph({ catalog, entity, groups, onShowList }: {
  catalog: Catalog; entity: Entity; groups: RelationGroup[]; onShowList: () => void;
}) {
  const incoming = groups.filter((g) => g.direction === "in");
  const outgoing = groups.filter((g) => g.direction === "out");
  // Leave out a side with nothing on it.
  const centerX = incoming.length ? PAD + NODE_W + GAP_X : PAD;
  const rightX = centerX + NODE_W + GAP_X;
  const left = layout(incoming, PAD);
  const right = layout(outgoing, rightX);
  const height = Math.max(left.height, right.height, NODE_H + 2 * PAD);
  const width = (outgoing.length ? rightX + NODE_W : centerX + NODE_W) + PAD;
  const centerY = Math.max(PAD, height / 2 - NODE_H / 2);
  const mid = (p: { y: number }) => p.y + NODE_H / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) / 2;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };

  const node = (e: Entity, x: number, y: number, focus = false) => {
    const marks = badges(catalog, e);
    const label = [`${typeLabel(e.type)}: ${e.displayName ?? e.name}`, ...marks.map((m) => m.title)].join("\n");
    const inner = (
      <>
        <span className="lineage-node-head">
          <span className="lineage-node-type">{typeLabel(e.type)}</span>
          {marks.length > 0 && (
            <span className="node-badges" aria-hidden>{marks.map((m) => <span key={m.kind} className={`node-badge node-badge-${m.kind}`}>{m.text}</span>)}</span>
          )}
        </span>
        <span className="lineage-node-name">{e.displayName ?? e.name}</span>
      </>
    );
    const style = { left: x, top: y, width: NODE_W, height: NODE_H };
    return focus ? (
      <div key={`focus:${e.id}`} className="lineage-node lineage-node-focus" style={style} title={label}>{inner}</div>
    ) : (
      <Link key={`${x}:${e.id}`} to={`${entityPath(e.id)}?tab=relationships&view=graph`} className="lineage-node" style={style} title={label} aria-label={label}>{inner}</Link>
    );
  };

  return (
    <div className="lineage-scroll" role="img" aria-label={`Relationships of ${entity.displayName ?? entity.name}: incoming on the left, outgoing on the right`}>
      <div className="lineage-canvas" style={{ width, height }}>
        <svg width={width} height={height} className="lineage-svg" aria-hidden>
          {left.nodes.map((n) => (
            <path key={`l:${n.entity.id}:${n.y}`} className="lineage-edge" d={curve(n.x + NODE_W, mid(n), centerX, centerY + NODE_H / 2)} />
          ))}
          {right.nodes.map((n) => (
            <path key={`r:${n.entity.id}:${n.y}`} className="lineage-edge" d={curve(centerX + NODE_W, centerY + NODE_H / 2, n.x, mid(n))} />
          ))}
        </svg>
        {[...left.heads.map((h) => ({ ...h, x: PAD })), ...right.heads.map((h) => ({ ...h, x: rightX }))].map((h) => (
          <div key={`${h.x}:${h.label}`} className="rel-head" style={{ left: h.x, top: h.y, width: NODE_W }}>{h.label}</div>
        ))}
        {left.nodes.map((n) => node(n.entity, n.x, n.y))}
        {right.nodes.map((n) => node(n.entity, n.x, n.y))}
        {[...left.heads.map((h, i) => ({ h, x: PAD, i, col: left })), ...right.heads.map((h, i) => ({ h, x: rightX, i, col: right }))]
          .filter(({ h }) => h.more > 0)
          .map(({ h, x, i, col }) => {
            const next = col.heads[i + 1]?.y ?? col.height;
            return (
              <button key={`more:${x}:${h.label}`} type="button" className="link-btn rel-more" style={{ left: x, top: next - GROUP_GAP - 22 }} onClick={onShowList}>
                +{h.more} more in the list
              </button>
            );
          })}
        {node(entity, centerX, centerY, true)}
      </div>
    </div>
  );
}
