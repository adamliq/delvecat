import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { LazyDetails } from "../components/LazyDetails";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";
import { useUrlState } from "../lib/urlState";

import { buildChanges, type DiffRow } from "../lib/changes";
export type { DiffRow };

const show = (v: unknown) => (v === null || v === undefined ? <span className="muted">—</span> : typeof v === "string" ? v : JSON.stringify(v));
const keyLabel = (k: string) => k.replace(/^properties\./, "");

/** Before and after, key by key. */
export function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="table-wrap">
      <table className="mini-table diff-table">
        <thead><tr><th>What</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><code>{keyLabel(r.key)}</code></td>
              <td className="diff-before">{show(r.before)}</td>
              <td className="diff-after">{show(r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything that changed between the previous build and this one: added, modified
 * (with what changed) and removed objects, by type. */
export function ChangesPage() {
  const { catalog } = useCatalog();
  const builds = buildChanges(catalog);
  const [params, setParams] = useUrlState();
  const type = params.get("type") ?? "";
  const setType = (v: string) => setParams({ type: v || null });
  const pick = Math.min(Math.max(0, Number(params.get("build") ?? 0) || 0), Math.max(0, builds.length - 1));
  const changes = builds[pick];
  if (!changes) {
    return (
      <div className="stack">
        <h1>Changes</h1>
        <p className="muted">This is the first build of this catalog: there is nothing to compare with yet.</p>
      </div>
    );
  }
  const details = changes.details;
  const get = (id: string) => catalog.byId.get(id);
  const added = changes.added.map(get).filter((e): e is Entity => !!e);
  const modified = changes.modified.map(get).filter((e): e is Entity => !!e);
  const removed = changes.removed;
  const types = [...new Set([...added, ...modified].map((e) => e.type as string).concat(removed.map((r) => r.type)))].sort();
  const keep = (t: string) => !type || t === type;
  const name = (e: Entity) => <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link></>;

  return (
    <div className="stack">
      <div>
        <h1>Changes</h1>
        <p className="lede">What changed in Splunk between the build of {new Date(changes.previousGeneratedAt).toLocaleString()} and the one of {new Date(changes.generatedAt).toLocaleString()}.</p>
      </div>
      {builds.length > 1 && (
        <label className="sort">Build
          <select value={pick} onChange={(e) => setParams({ build: e.target.value === "0" ? null : e.target.value })}>
            {builds.map((b, i) => (
              <option key={b.generatedAt} value={i}>
                {new Date(b.generatedAt).toLocaleString()}{i === 0 ? " (latest)" : ""} · {b.added.length} added, {b.modified.length} modified, {b.removed.length} removed
              </option>
            ))}
          </select>
        </label>
      )}
      {pick > 0 && <p className="muted small">Objects added or modified then may have changed or gone since; links open them as they are now.</p>}
      <div className="tiles">
        <div className="tile static"><span className="tile-num">{added.length}</span><span className="tile-label">added</span></div>
        <div className="tile static"><span className="tile-num">{modified.length}</span><span className="tile-label">modified</span></div>
        <div className="tile static"><span className="tile-num">{removed.length}</span><span className="tile-label">removed</span></div>
      </div>
      {types.length > 1 && (
        <label className="sort">Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{pluralTypeLabel(t as Entity["type"])}</option>)}
          </select>
        </label>
      )}

      <section>
        <h2>Modified <span className="muted">({modified.filter((e) => keep(e.type)).length})</span></h2>
        {modified.filter((e) => keep(e.type)).length === 0 ? <p className="muted">Nothing modified.</p> : (
          <ul className="plain-list">
            {modified.filter((e) => keep(e.type)).map((e) => {
              const rows = details[e.id] ?? [];
              return (
                <li key={e.id}>
                  {rows.length ? (
                    <LazyDetails summary={<>{name(e)} <span className="muted small">{rows.map((r) => keyLabel(r.key)).slice(0, 4).join(", ")}{rows.length > 4 ? "…" : ""}</span></>}>
                      {() => <DiffTable rows={rows} />}
                    </LazyDetails>
                  ) : <>{name(e)} <span className="muted small">(details not kept)</span></>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>Added <span className="muted">({added.filter((e) => keep(e.type)).length})</span></h2>
        <DataTable rows={added.filter((e) => keep(e.type))} rowKey={(e) => e.id} csvName="delvecat-added.csv" limit={100}
          columns={[
            { label: "Object", value: (e) => e.displayName ?? e.name, render: name },
            { label: "App", value: (e) => e.app ?? "" },
            { label: "Owner", value: (e) => e.owner ?? "" },
          ]} />
      </section>

      <section>
        <h2>Removed <span className="muted">({removed.filter((r) => keep(r.type)).length})</span></h2>
        <DataTable rows={removed.filter((r) => keep(r.type))} rowKey={(r) => r.id} csvName="delvecat-removed.csv" limit={100}
          columns={[
            { label: "Type", value: (r) => typeLabel(r.type as Entity["type"]) },
            { label: "Name", value: (r) => r.name },
            { label: "Id", value: (r) => r.id, render: (r) => <code className="small">{r.id}</code> },
          ]} />
      </section>
    </div>
  );
}
