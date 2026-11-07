import { useState } from "react";
import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { fieldName } from "../lib/fieldLineage";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";
import { cimCoverage, schemaFields } from "../lib/schema";

const COL_W = 220;
const GAP = 110;
const ROW_H = 30;
const HEAD_H = 34;
const PAD = 10;
const CONSUMER_H = 46;

interface Box { key: string; x: number; y: number; h: number }

/** Sourcetype fields -> data model fields -> the objects that read them. */
export function SourcetypeFieldLineage({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const [active, setActive] = useState<string | null>(null);
  const fields = schemaFields(catalog, entity);
  if (!fields.length) return null;
  const cim = cimCoverage(catalog, entity);
  const dmRows = cim.models.flatMap((m) => [...cim.cimFields].sort().map((n) => ({ model: m, name: n })));

  // Consumers: objects reading a field directly, or reading a data model and using one of its fields.
  const consumers = new Map<string, { entity: Entity; fields: Set<string>; viaModel: Set<string> }>();
  const add = (e: Entity, key: string, viaModel?: string) => {
    const c = consumers.get(e.id) ?? { entity: e, fields: new Set<string>(), viaModel: new Set<string>() };
    if (viaModel) c.viaModel.add(key); else c.fields.add(key);
    consumers.set(e.id, c);
  };
  for (const f of fields) for (const x of catalog.edgesTo(f.id)) {
    const e = catalog.byId.get(x.from);
    if (e && x.type === "readsField" && e.type !== "dataModel") add(e, fieldName(f));
  }
  for (const m of cim.models) for (const x of catalog.edgesTo(m.id)) {
    const e = catalog.byId.get(x.from);
    if (!e || x.type !== "reads") continue;
    const used = (e.lineage?.fields?.used ?? []).map((u) => u.name.slice(u.name.lastIndexOf(".") + 1));
    for (const n of used) if (cim.cimFields.has(n)) add(e, `${m.id}|${n}`, m.id);
  }
  const consumerList = [...consumers.values()].sort((a, b) => a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));

  const x1 = PAD, x2 = PAD + COL_W + GAP, x3 = dmRows.length ? x2 + COL_W + GAP : x2;
  const left: (Box & { name: string; reaches: boolean })[] = fields.map((f, i) => {
    const name = fieldName(f);
    const reaches = cim.cimFields.has(name) || [...consumers.values()].some((c) => c.fields.has(name));
    return { key: `f:${name}`, name, x: x1, y: HEAD_H + i * ROW_H, h: ROW_H - 6, reaches };
  });
  let y = HEAD_H;
  const mid: (Box & { name: string; model: Entity; header?: boolean })[] = [];
  for (const m of cim.models) {
    mid.push({ key: `h:${m.id}`, name: m.displayName ?? m.name, model: m, x: x2, y, h: ROW_H - 6, header: true });
    y += ROW_H;
    for (const n of [...cim.cimFields].sort()) {
      mid.push({ key: `d:${m.id}|${n}`, name: n, model: m, x: x2, y, h: ROW_H - 6 });
      y += ROW_H;
    }
  }
  const right: (Box & { c: (typeof consumerList)[number] })[] = consumerList.map((c, i) => ({ key: `c:${c.entity.id}`, c, x: x3, y: HEAD_H + i * (CONSUMER_H + 8), h: CONSUMER_H }));

  const height = Math.max(...[...left, ...mid, ...right].map((b) => b.y + b.h), HEAD_H + ROW_H) + PAD;
  const width = x3 + COL_W + PAD;
  const curve = (ax: number, ay: number, bx: number, by: number) => {
    const dx = (bx - ax) / 2;
    return `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
  };
  const midY = (b: Box) => b.y + b.h / 2;
  const edges: { key: string; d: string; ends: [string, string] }[] = [];
  for (const l of left) {
    const rows = mid.filter((m) => !m.header && m.name === l.name);
    for (const d of rows) edges.push({ key: `${l.key}>${d.key}`, d: curve(l.x + COL_W, midY(l), d.x, midY(d)), ends: [l.key, d.key] });
    // A reader of a field that is also a data model field is drawn from the data model
    // row (the same field), so lines do not cross behind the middle column.
    const from = rows[0] ?? l;
    for (const r of right.filter((r) => r.c.fields.has(l.name))) {
      edges.push({ key: `${from.key}>${r.key}`, d: curve(from.x + COL_W, midY(from), r.x, midY(r)), ends: [from.key, r.key] });
    }
  }
  for (const d of mid.filter((m) => !m.header)) {
    for (const r of right.filter((r) => r.c.viaModel.has(`${d.model.id}|${d.name}`))) edges.push({ key: `${d.key}>${r.key}`, d: curve(d.x + COL_W, midY(d), r.x, midY(r)), ends: [d.key, r.key] });
  }
  const lit = new Set<string>();
  if (active) {
    const seen = new Set([active]);
    const stack = [active];
    while (stack.length) {
      const k = stack.pop()!;
      for (const e of edges) if (e.ends.includes(k)) {
        lit.add(e.key);
        for (const end of e.ends) if (!seen.has(end)) { seen.add(end); stack.push(end); }
      }
    }
  }
  const hover = (key: string) => ({
    tabIndex: 0, onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null), onFocus: () => setActive(key), onBlur: () => setActive(null),
  });
  const stops = left.filter((l) => !l.reaches);

  return (
    <section>
      <h2>Field lineage</h2>
      <p className="muted small">
        Fields of this sourcetype, the data model fields they provide, and the searches, dashboards and configuration that read them (directly or through the data model).
        Hover or focus a field to trace it.
      </p>
      <div className="lineage-scroll col-lineage" role="img" aria-label={`Field lineage of ${entity.name}`}>
        <div className="lineage-canvas" style={{ width, height }}>
          <svg width={width} height={height} className="lineage-svg" aria-hidden>
            {edges.map((e) => <path key={e.key} d={e.d} className={`col-edge${active ? (lit.has(e.key) ? " col-edge-lit" : " col-edge-dim") : ""}`} />)}
          </svg>
          <div className="col-head" style={{ left: x1, width: COL_W }}>Sourcetype {entity.name}</div>
          {dmRows.length > 0 && <div className="col-head" style={{ left: x2, width: COL_W }}>Data model fields</div>}
          <div className="col-head" style={{ left: x3, width: COL_W }}>Read by ({consumerList.length})</div>
          {left.map((l) => (
            <div key={l.key} className={`col-node${l.reaches ? "" : " col-node-muted"}${active === l.key ? " col-node-active" : ""}`}
              style={{ left: l.x, top: l.y, width: COL_W, height: l.h }} {...hover(l.key)} title={l.reaches ? l.name : `${l.name}: not used and not a data model field`}>
              <code className="col-node-name">{l.name}</code>{!l.reaches && <span className="col-node-note">stops here</span>}
            </div>
          ))}
          {mid.map((d) => d.header ? (
            <div key={d.key} className="col-subhead" style={{ left: d.x, top: d.y, width: COL_W }}>
              <Link to={entityPath(d.model.id)}>{d.name}</Link>
            </div>
          ) : (
            <div key={d.key} className={`col-node${active === d.key ? " col-node-active" : ""}`} style={{ left: d.x, top: d.y, width: COL_W, height: d.h }} {...hover(d.key)}>
              <code className="col-node-name">{d.name}</code>
            </div>
          ))}
          {right.map((r) => (
            <Link key={r.key} to={entityPath(r.c.entity.id)} className={`lineage-node${active === r.key ? " lineage-node-focus" : ""}`}
              style={{ left: r.x, top: r.y, width: COL_W, height: r.h }} {...hover(r.key)}
              title={`${typeLabel(r.c.entity.type)}: ${r.c.entity.displayName ?? r.c.entity.name}`}>
              <span className="lineage-node-type">{typeLabel(r.c.entity.type)} · {r.c.fields.size + r.c.viaModel.size} field{r.c.fields.size + r.c.viaModel.size === 1 ? "" : "s"}</span>
              <span className="lineage-node-name">{r.c.entity.displayName ?? r.c.entity.name}</span>
            </Link>
          ))}
        </div>
      </div>
      <ul className="impact-list small">
        <li><strong>{cim.cimFields.size} of {fields.length}</strong> fields reach {cim.models.length ? "the data model" : "no data model (not mapped)"}</li>
        <li><strong>{consumerList.length}</strong> objects read these fields{cim.models.length ? " directly or through the data model" : ""}</li>
        {stops.length > 0 && <li><strong>{stops.length}</strong> {stops.length === 1 ? "field stops" : "fields stop"} here: {stops.slice(0, 8).map((s, i) => <span key={s.key}>{i > 0 && ", "}<code>{s.name}</code></span>)}{stops.length > 8 && " …"}</li>}
      </ul>
    </section>
  );
}
