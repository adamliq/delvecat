import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { fieldName } from "../lib/fieldLineage";
import { entityPath } from "../lib/routes";
import { dataModelsOf, fieldType, schemaFields, similarity } from "../lib/schema";

export type NetworkMode = "fields" | "overlap";

interface Node extends SimulationNodeDatum {
  id: string;
  kind: "st" | "field";
  label: string;
  r: number;
  st?: Entity;
  colorSlot?: number; // 1-3, or undefined for "other / not mapped"
  members?: { st: Entity; field: Entity }[];
  inconsistent?: boolean;
  labelled?: boolean;
}
interface Edge { source: string | Node; target: string | Node; weight: number; shared?: string[] }

const W = 900;
/** Beyond this a force layout is unreadable (and slow): show the sourcetypes with most fields. */
export const MAX_SOURCETYPES = 60;
/** Field nodes shown: the most shared, so the graph stays legible. */
export const MAX_FIELDS = 40;
/** Field names labelled; the rest are named on hover and in the detail panel. */
const LABELLED_FIELDS = 20;
/** In overlap mode keep each sourcetype's strongest links only. */
const LINKS_PER_NODE = 3;
const H = 560;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Data models ranked by how many of the given sourcetypes feed them; the top three get a color. */
export function modelSlots(catalog: Catalog, sts: Entity[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sts) for (const m of dataModelsOf(catalog, s)) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  return new Map(ranked.map(([name], i) => [name, i + 1]));
}

/**
 * Sourcetypes and the field names they share (fields mode), or sourcetypes linked
 * by how many fields they share (overlap mode). Laid out once with a force
 * simulation; hover or focus a node to see its neighbors, select it for details.
 */
export function SchemaNetwork({ catalog, sourcetypes: all, mode, minShared }: {
  catalog: Catalog; sourcetypes: Entity[]; mode: NetworkMode; minShared: number;
}) {
  const sourcetypes = useMemo(() => all.length <= MAX_SOURCETYPES ? all
    : [...all].sort((a, b) => schemaFields(catalog, b).length - schemaFields(catalog, a).length || a.name.localeCompare(b.name)).slice(0, MAX_SOURCETYPES),
  [catalog, all]);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const slots = useMemo(() => modelSlots(catalog, sourcetypes), [catalog, sourcetypes]);

  const { nodes, edges, hiddenFields } = useMemo(() => {
    let hiddenFields = 0;
    const fieldsOf = new Map(sourcetypes.map((s) => [s.id, schemaFields(catalog, s)]));
    const nodes: Node[] = sourcetypes.map((s) => {
      const model = dataModelsOf(catalog, s).find((m) => slots.has(m.name));
      return { id: s.id, kind: "st", st: s, label: s.displayName ?? s.name, r: 6 + Math.sqrt(fieldsOf.get(s.id)!.length) * 1.6, colorSlot: model ? slots.get(model.name) : undefined };
    });
    const edges: Edge[] = [];
    if (mode === "fields") {
      const byName = new Map<string, { st: Entity; field: Entity }[]>();
      for (const s of sourcetypes) for (const f of fieldsOf.get(s.id)!) {
        const n = fieldName(f);
        byName.set(n, [...(byName.get(n) ?? []), { st: s, field: f }]);
      }
      const shared = [...byName].filter(([, members]) => members.length >= minShared)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      shared.slice(0, MAX_FIELDS).forEach(([name, members], rank) => {
        const types = new Set(members.map((m) => fieldType(m.field)).filter((t) => t !== "unknown"));
        nodes.push({ id: `field:${name}`, kind: "field", label: name, r: Math.min(14, 3 + Math.sqrt(members.length) * 1.5), members,
          inconsistent: types.size > 1, labelled: rank < LABELLED_FIELDS });
        for (const m of members) edges.push({ source: m.st.id, target: `field:${name}`, weight: 1 });
      });
      hiddenFields = Math.max(0, shared.length - MAX_FIELDS);
    } else {
      const names = new Map(sourcetypes.map((s) => [s.id, new Set(fieldsOf.get(s.id)!.map(fieldName))]));
      const candidates: Edge[] = [];
      for (let i = 0; i < sourcetypes.length; i++) for (let j = i + 1; j < sourcetypes.length; j++) {
        const sim = similarity(names.get(sourcetypes[i].id)!, names.get(sourcetypes[j].id)!);
        if (sim.shared.length >= minShared) candidates.push({ source: sourcetypes[i].id, target: sourcetypes[j].id, weight: sim.shared.length, shared: sim.shared });
      }
      // Keep a link when it is among the strongest few of either end, so the graph stays readable.
      const best = new Map<string, number>();
      const byNode = new Map<string, number[]>();
      for (const e of candidates) for (const id of [e.source as string, e.target as string]) byNode.set(id, [...(byNode.get(id) ?? []), e.weight]);
      for (const [id, ws] of byNode) best.set(id, ws.sort((a, b) => b - a)[Math.min(LINKS_PER_NODE, ws.length) - 1]);
      for (const e of candidates) if (e.weight >= best.get(e.source as string)! || e.weight >= best.get(e.target as string)!) edges.push(e);
    }
    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Edge>(edges).id((d) => d.id).distance((e) => (mode === "fields" ? 55 : 190 - Math.min(120, e.weight * 8))).strength(mode === "fields" ? 0.5 : 0.3))
      .force("charge", forceManyBody().strength(mode === "fields" ? -140 : -420))
      .force("x", forceX(W / 2).strength(0.06))
      .force("y", forceY(H / 2).strength(0.09))
      .force("collide", forceCollide<Node>((d) => d.r + 8))
      .stop();
    for (let i = 0; i < 320; i++) sim.tick();
    for (const n of nodes) {
      n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x ?? W / 2));
      n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y ?? H / 2));
    }
    return { nodes, edges, hiddenFields };
  }, [catalog, sourcetypes, mode, minShared, slots]);

  const node = (e: Edge, end: "source" | "target") => e[end] as Node;
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set([n.id])]));
    for (const e of edges) { m.get(node(e, "source").id)!.add(node(e, "target").id); m.get(node(e, "target").id)!.add(node(e, "source").id); }
    return m;
  }, [nodes, edges]);
  const focus = hover ?? selected;
  const near = focus ? neighbors.get(focus) : undefined;
  const sel = nodes.find((n) => n.id === selected);
  const legendSlots = [...slots.entries()].sort((a, b) => a[1] - b[1]);

  if (!sourcetypes.length) return <p className="muted">No sourcetypes match the filters.</p>;

  return (
    <div className="stack">
      {(all.length > sourcetypes.length || hiddenFields > 0) && (
        <p className="muted small">
          {all.length > sourcetypes.length && <>Showing the {sourcetypes.length} sourcetypes with the most fields, of {all.length.toLocaleString()} that match. </>}
          {hiddenFields > 0 && <>Showing the {MAX_FIELDS} most shared fields ({hiddenFields} more not drawn). </>}
          Filter by data model, owner or search, or raise "shared by at least", to see others.
        </p>
      )}
      <div className="network-box">
        <svg viewBox={`0 0 ${W} ${H}`} className="network-svg" role="img" aria-label={mode === "fields" ? "Network of sourcetypes and the field names they share" : "Network of sourcetypes linked by shared fields"}>
          {edges.map((e, i) => {
            const a = node(e, "source"), b = node(e, "target");
            const lit = focus && (a.id === focus || b.id === focus);
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className={`net-edge${lit ? " net-edge-lit" : focus ? " net-edge-dim" : ""}`}
              strokeWidth={mode === "overlap" ? Math.min(1 + e.weight * 0.6, 7) : 1} />;
          })}
          {nodes.map((n) => {
            const dim = near && !near.has(n.id);
            const cls = n.kind === "st" ? `net-st ${n.colorSlot ? `net-slot-${n.colorSlot}` : "net-other"}` : `net-field${n.inconsistent ? " net-inconsistent" : ""}`;
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`net-node${dim ? " net-dim" : ""}${selected === n.id ? " net-selected" : ""}`}
                tabIndex={0} role="button" aria-label={n.kind === "st" ? `Sourcetype ${n.label}` : `Field ${n.label}, in ${n.members!.length} sourcetypes${n.inconsistent ? ", typed inconsistently" : ""}`}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
                onClick={() => setSelected(selected === n.id ? null : n.id)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected(selected === n.id ? null : n.id); } }}>
                <circle r={Math.max(n.r + 6, 12)} className="net-hit" />
                <circle r={n.r} className={cls} />
                {n.inconsistent && <text className="net-glyph" y={3.5} textAnchor="middle">!</text>}
                <title>{n.kind === "st" ? n.label : `${n.label}: in ${n.members!.length} sourcetypes`}</title>
                {(n.kind === "st" || n.labelled) && (
                  <text x={n.r + 4} y={4} className={`net-label${n.kind === "field" ? " net-label-field" : ""}`}>{truncate(n.label, 24)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="legend" aria-label="Legend">
        {legendSlots.map(([name, slot]) => <li key={name}><span className={`net-key net-slot-${slot}`} />{name}</li>)}
        <li><span className="net-key net-other" />Other or not mapped</li>
        {mode === "fields" && <li><span className="net-key net-key-field" />Shared field</li>}
        {mode === "fields" && <li><span className="net-key net-key-field net-inconsistent-key">!</span>Typed inconsistently</li>}
      </ul>
      <div className="network-detail" aria-live="polite">
        {!sel ? <p className="muted small">Select a sourcetype or field to see how it connects. Hover to highlight its neighbors.</p>
          : sel.kind === "st" ? <SourcetypeDetail catalog={catalog} st={sel.st!} sourcetypes={sourcetypes} />
          : <FieldDetail node={sel} />}
      </div>
    </div>
  );
}

function SourcetypeDetail({ catalog, st, sourcetypes }: { catalog: Catalog; st: Entity; sourcetypes: Entity[] }) {
  const mine = new Set(schemaFields(catalog, st).map(fieldName));
  const others = sourcetypes.filter((o) => o.id !== st.id)
    .map((o) => ({ o, ...similarity(mine, new Set(schemaFields(catalog, o).map(fieldName))) }))
    .filter((r) => r.shared.length).sort((a, b) => b.shared.length - a.shared.length);
  return (
    <>
      <h3><Link to={`${entityPath(st.id)}?tab=fields`}>{st.displayName ?? st.name}</Link></h3>
      <p className="small">Shares field names with {others.length} other sourcetype{others.length === 1 ? "" : "s"} in view.</p>
      {others.length > 0 && (
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Sourcetype</th><th>Shared fields</th><th /></tr></thead>
            <tbody>{others.slice(0, 8).map((r) => (
              <tr key={r.o.id}>
                <td><Link to={`${entityPath(r.o.id)}?tab=fields`}>{r.o.displayName ?? r.o.name}</Link></td>
                <td className="small">{r.shared.join(", ")}</td>
                <td><Link className="small" to={`/compare?a=${encodeURIComponent(st.id)}&b=${encodeURIComponent(r.o.id)}`}>Compare</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function FieldDetail({ node }: { node: Node }) {
  const types = [...new Set(node.members!.map((m) => fieldType(m.field)).filter((t) => t !== "unknown"))];
  return (
    <>
      <h3><code>{node.label}</code></h3>
      <p className="small">
        In {node.members!.length} sourcetypes.{" "}
        {node.inconsistent ? <span className="status-label status-warning">! Typed inconsistently: {types.join(", ")}</span>
          : types.length ? `Typed consistently as ${types[0]}.` : ""}
      </p>
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr><th>Sourcetype</th><th>Type</th></tr></thead>
          <tbody>{node.members!.map((m) => (
            <tr key={m.field.id}><td><Link to={entityPath(m.field.id)}>{m.st.displayName ?? m.st.name}</Link></td><td>{fieldType(m.field) === "unknown" ? "config" : fieldType(m.field)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
