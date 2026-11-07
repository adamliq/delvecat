import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { access, effectiveClassifications, HOW_LABEL, isSensitive, matchesClass, readsClassified, sensitiveAccess } from "../lib/governance";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";

const STORE_ORDER = ["index", "lookup", "kvCollection", "externalTable", "dataModel", "sourcetype"];

function Name({ e }: { e?: Entity }) {
  if (!e) return null;
  return <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>;
}

export function GovernancePage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const filter = params.get("classification") ?? "";
  const byId = catalog.byId;

  const stores = useMemo(() => catalog.entities.filter((e) => isSensitive(e) && STORE_ORDER.includes(e.type))
    .sort((a, b) => STORE_ORDER.indexOf(a.type) - STORE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name)), [catalog]);
  const classes = [...new Set(stores.flatMap((s) => effectiveClassifications(s).filter((c) => c.sensitive).map((c) => c.name)))].sort();
  const roots = [...new Set(classes.map((c) => c.split(".")[0]))];
  const matching = stores.filter((s) => effectiveClassifications(s).some((c) => c.sensitive && matchesClass(c.name, filter)));
  const reachable = matching.filter((s) => access(s));
  const roles = catalog.entities.filter((e) => e.type === "role" && sensitiveAccess(e).some((a) => reachable.some((s) => s.id === a.id)));
  const users = catalog.entities.filter((e) => e.type === "user" && sensitiveAccess(e).some((a) => reachable.some((s) => s.id === a.id)));
  const everyone = matching.filter((s) => access(s)?.everyone);
  const consumers = catalog.entities.filter((e) => readsClassified(e).some((c) => matchesClass(c, filter)));
  const taxonomy = catalog.bundle.classifications ?? [];

  if (!stores.length) {
    return (
      <div className="stack">
        <h1>Governance</h1>
        <p className="muted">No sensitive classifications in this bundle. Classify fields, sourcetypes, indexes or lookups in <code>annotations/</code> (for example <code>classifications: [PII.Email]</code>) to see who can reach them.</p>
      </div>
    );
  }
  const setFilter = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set("classification", v);
    else next.delete("classification");
    setParams(next, { replace: true });
  };
  const cell = (role: Entity, store: Entity) => {
    const a = sensitiveAccess(role).find((x) => x.id === store.id);
    if (!a) return <span className="muted" aria-label="no access">·</span>;
    return a.how === "read" ? <span title="Read permission on the object">✓ read</span>
      : a.filtered ? <span title="Search access limited by the role's search filter">◐ filtered</span>
      : <span title="Can search this index">✓ search</span>;
  };

  return (
    <div className="stack">
      <div>
        <h1>Governance</h1>
        <p className="lede">Where sensitive data lives, how it spreads through lineage, and who can reach it.</p>
      </div>

      <section className="question">
        <label className="sort">
          Who can see
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">any sensitive data</option>
            {roots.map((r) => <option key={r} value={r}>{r} (any)</option>)}
            {classes.filter((c) => !roots.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div className="tiles">
          <div className="tile static"><span className="tile-num">{matching.length}</span><span className="tile-label">sensitive data stores</span></div>
          <div className="tile static"><span className="tile-num">{roles.length}</span><span className="tile-label">roles can reach them</span></div>
          <div className="tile static"><span className="tile-num">{users.length}</span><span className="tile-label">users can reach them</span></div>
          <div className="tile static"><span className="tile-num">{everyone.length}</span><span className="tile-label">readable by every role</span></div>
        </div>
      </section>

      {everyone.length > 0 && (
        <section className="notice">
          <h2>Exposed to every role</h2>
          <ul className="plain-list">
            {everyone.map((s) => (
              <li key={s.id}><span className="muted rel-type">{typeLabel(s.type)}</span> <Name e={s} />{" "}
                <span className="muted small">{effectiveClassifications(s).filter((c) => c.sensitive).map((c) => c.name).join(", ")} · read permission is <code>*</code> or a default role can search it</span></li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Sensitive data and who can reach it</h2>
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Data</th><th>Classification</th><th>Roles</th><th>Users</th></tr></thead>
            <tbody>
              {matching.map((s) => {
                const a = access(s);
                return (
                  <tr key={s.id}>
                    <td><span className="muted rel-type">{typeLabel(s.type)}</span> <Name e={s} /></td>
                    <td>{effectiveClassifications(s).filter((c) => c.sensitive && matchesClass(c.name, filter)).map((c) => (
                      <div key={c.name}>{c.name} <span className="muted small">{HOW_LABEL[c.how]}{c.via && byId.get(c.via) ? <> (<Name e={byId.get(c.via)} />)</> : null}{c.columns?.length ? <> · in <code>{c.columns.join(", ")}</code></> : null}</span></div>
                    ))}</td>
                    <td>{a ? a.roles.map((r, i) => <span key={r}>{i > 0 && ", "}<Name e={byId.get(r)} />{a.filteredRoles.includes(r) && <span className="muted small"> (filtered)</span>}</span>) : <span className="muted">no role (sourcetype or table)</span>}</td>
                    <td>{a ? (a.users.length ? a.users.map((u, i) => <span key={u}>{i > 0 && ", "}<Name e={byId.get(u)} /></span>) : <span className="muted">none</span>) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {roles.length > 0 && reachable.length > 0 && (
        <section>
          <h2>Role access matrix</h2>
          <p className="muted small">✓ search: the role can search the index (including access inherited from imported roles). ◐ filtered: a search filter limits which events it sees. ✓ read: read permission on a lookup or collection.</p>
          <div className="table-wrap">
            <table className="mini-table matrix">
              <thead><tr><th>Role</th>{reachable.map((s) => <th key={s.id} title={s.id}>{s.displayName ?? s.name}</th>)}</tr></thead>
              <tbody>
                {roles.sort((a, b) => a.name.localeCompare(b.name)).map((r) => (
                  <tr key={r.id}><td><Name e={r} /></td>{reachable.map((s) => <td key={s.id}>{cell(r, s)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {consumers.length > 0 && (
        <section>
          <h2>Searches and dashboards reading sensitive data</h2>
          <ul className="plain-list">
            {consumers.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)).map((c) => (
              <li key={c.id}><span className="muted rel-type">{typeLabel(c.type)}</span> <Name e={c} /> <span className="muted small">{readsClassified(c).join(", ")}</span></li>
            ))}
          </ul>
        </section>
      )}

      {taxonomy.length > 0 && (
        <section>
          <h2>Classification taxonomy</h2>
          <dl className="glossary">
            {taxonomy.map((t) => (
              <div key={t.name} className="glossary-item">
                <dt>{t.name} <span className="muted small">{t.sensitive === false ? "not sensitive" : "sensitive"}{t.propagate === false ? " · not propagated" : ""}</span></dt>
                <dd>{t.description ?? ""}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
