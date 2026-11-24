import { useMemo, type ReactNode } from "react";
import { DataTable } from "../components/DataTable";
import { Link, useSearchParams } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { access, effectiveClassifications, HOW_LABEL, isSensitive, matchesClass, readsClassified, sensitiveAccess } from "../lib/governance";
import { typeLabel } from "../lib/labels";
import { owners } from "../lib/annotate";
import { entityPath } from "../lib/routes";

const STORE_ORDER = ["index", "lookup", "kvCollection", "externalTable", "dataModel", "sourcetype"];

function Name({ e }: { e?: Entity }) {
  if (!e) return null;
  return <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>;
}


const MATRIX_STORES = 40;
const MATRIX_ROLES = 60;
const FEW = 8;

/** The first few of a long list of names, then "and N more". */
function Few({ ids, render }: { ids: string[]; render: (id: string) => ReactNode }) {
  return (
    <>
      {ids.slice(0, FEW).map((id, i) => <span key={id}>{i > 0 && ", "}{render(id)}</span>)}
      {ids.length > FEW && <span className="muted small"> and {ids.length - FEW} more</span>}
    </>
  );
}

const schedRuns = (e: Entity): number => Number((e.usage?.scheduler as { total?: number } | undefined)?.total ?? 0);

/** Roles allowed to run (read) an object, or its sharing when that says more. */
function runners(e: Entity): string {
  const read = (e.permissions as { read?: string[] } | undefined)?.read ?? [];
  if (read.includes("*")) return "every role";
  if (read.length) return read.join(", ");
  return e.sharing === "user" ? `only ${e.owner ?? "its owner"}` : "";
}

export function GovernancePage() {
  const { catalog } = useCatalog();
  const [params, setParams] = useSearchParams();
  const filter = params.get("classification") ?? "";
  const userFilter = params.get("user") ?? "";
  const byId = catalog.byId;

  const stores = useMemo(() => catalog.entities.filter((e) => isSensitive(e) && STORE_ORDER.includes(e.type))
    .sort((a, b) => STORE_ORDER.indexOf(a.type) - STORE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name)), [catalog]);
  const classes = [...new Set(stores.flatMap((s) => effectiveClassifications(s).filter((c) => c.sensitive).map((c) => c.name)))].sort();
  const roots = [...new Set(classes.map((c) => c.split(".")[0]))];
  const matching = stores.filter((s) => effectiveClassifications(s).some((c) => c.sensitive && matchesClass(c.name, filter)));
  const reachable = matching.filter((s) => access(s));
  const reachableIds = new Set(reachable.map((s) => s.id));
  const roles = catalog.entities.filter((e) => e.type === "role" && sensitiveAccess(e).some((a) => reachableIds.has(a.id)));
  const users = catalog.entities.filter((e) => e.type === "user" && sensitiveAccess(e, catalog).some((a) => reachableIds.has(a.id)));
  const groups = catalog.entities.filter((e) => e.type === "authGroup" && sensitiveAccess(e, catalog).some((a) => reachableIds.has(a.id)));
  const everyone = matching.filter((s) => access(s)?.everyone && !access(s)?.masked);
  const masked = matching.filter((s) => access(s)?.masked || effectiveClassifications(s).some((c) => c.maskedBy?.length));
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
  // Large estates: hundreds of roles and stores. The matrix keeps the most-reached stores
  // and the widest-reaching roles; lists show the first few names.
  const accessOf = new Map(roles.map((r) => [r.id, new Map(sensitiveAccess(r).map((a) => [a.id, a]))]));
  const reach = (s: Entity) => roles.reduce((n, r) => n + (accessOf.get(r.id)!.has(s.id) ? 1 : 0), 0);
  const matrixStores = reachable.length > MATRIX_STORES ? [...reachable].sort((a, b) => reach(b) - reach(a)).slice(0, MATRIX_STORES) : reachable;
  const userRoles = userFilter
    ? new Set(catalog.edgesFrom(userFilter).filter((x) => x.type === "memberOf").map((x) => x.to))
    : undefined;
  const matrixRoles = [...roles].filter((r) => !userRoles || userRoles.has(r.id)).sort((a, b) => accessOf.get(b.id)!.size - accessOf.get(a.id)!.size || a.name.localeCompare(b.name)).slice(0, MATRIX_ROLES)
    .sort((a, b) => a.name.localeCompare(b.name));
  const cell = (role: Entity, store: Entity) => {
    const a = accessOf.get(role.id)?.get(store.id);
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
          {groups.length > 0 && (
            <div className="tile static"><span className="tile-num">{groups.length}</span><span className="tile-label">identity groups (SAML, LDAP) can reach them</span></div>
          )}
          <div className="tile static"><span className="tile-num">{everyone.length}</span><span className="tile-label">readable by every role</span></div>
          {masked.length > 0 && (
            <div className="tile static"><span className="tile-num">{masked.length}</span><span className="tile-label">masked by field filters</span></div>
          )}
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
        <DataTable
          rows={matching}
          rowKey={(s) => s.id}
          csvName="delvecat-sensitive-data-access.csv"
          columns={[
            { label: "Data", value: (s) => s.displayName ?? s.name, render: (s) => <><span className="muted rel-type">{typeLabel(s.type)}</span> <Name e={s} /></> },
            { label: "Classification", value: (s) => effectiveClassifications(s).filter((c) => c.sensitive && matchesClass(c.name, filter)).map((c) => c.name).join(", "),
              render: (s) => effectiveClassifications(s).filter((c) => c.sensitive && matchesClass(c.name, filter)).map((c) => (
                <div key={c.name}>{c.name} <span className="muted small">{HOW_LABEL[c.how]}{c.via && byId.get(c.via) ? <> (<Name e={byId.get(c.via)} />)</> : null}{c.columns?.length ? <> · in <code>{c.columns.join(", ")}</code></> : null}</span></div>
              )) },
            { label: "Roles", value: (s) => access(s)?.roles.length ?? -1, render: (s) => {
              const a = access(s);
              return a ? <Few ids={a.roles} render={(r) => <><Name e={byId.get(r)} />{a.filteredRoles.includes(r) && <span className="muted small"> (filtered)</span>}</>} /> : <span className="muted">no role (sourcetype or table)</span>;
            } },
            { label: "Users", value: (s) => access(s)?.users.length ?? -1, render: (s) => {
              const a = access(s);
              return a ? (a.users.length ? <Few ids={a.users} render={(u) => <Name e={byId.get(u)} />} /> : <span className="muted">none</span>) : "—";
            } },
          ]}
        />
      </section>

      {roles.length > 0 && reachable.length > 0 && (
        <section>
          <h2>Role access matrix</h2>
          {(matrixStores.length < reachable.length || matrixRoles.length < roles.length) && (
            <p className="muted small">Showing the {matrixStores.length} most-reached data stores and the {matrixRoles.length} roles that reach the most, of {reachable.length} and {roles.length}. Filter by classification above to narrow it.</p>
          )}
          <label className="sort">
            Roles of user
            <select value={userFilter} onChange={(e) => { const next = new URLSearchParams(params); if (e.target.value) next.set("user", e.target.value); else next.delete("user"); setParams(next, { replace: true }); }}>
              <option value="">Every role</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.name}</option>)}
            </select>
          </label>
          {userFilter && <p className="small">{catalog.byId.get(userFilter)?.displayName ?? catalog.byId.get(userFilter)?.name} reaches {sensitiveAccess(catalog.byId.get(userFilter)!, catalog).filter((a) => reachableIds.has(a.id)).length} of these data stores through {matrixRoles.length} role{matrixRoles.length === 1 ? "" : "s"} (imported roles included in the access).</p>}
          <p className="muted small">✓ search: the role can search the index (including access inherited from imported roles). ◐ filtered: a search filter limits which events it sees. ✓ read: read permission on a lookup or collection.</p>
          <div className="table-wrap">
            <table className="mini-table matrix">
              <thead><tr><th>Role</th>{matrixStores.map((s) => <th key={s.id} title={s.id}>{s.displayName ?? s.name}</th>)}</tr></thead>
              <tbody>
                {matrixRoles.map((r) => (
                  <tr key={r.id}><td><Name e={r} /></td>{matrixStores.map((s) => <td key={s.id}>{cell(r, s)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {consumers.length > 0 && (
        <section>
          <h2>Searches and dashboards reading sensitive data</h2>
          <DataTable
            rows={consumers}
            rowKey={(c) => c.id}
            csvName="delvecat-sensitive-readers.csv"
            columns={[
              { label: "Object", value: (c) => c.displayName ?? c.name, render: (c) => <><span className="muted rel-type">{typeLabel(c.type)}</span> <Name e={c} /></> },
              { label: "Reads", value: (c) => readsClassified(c).join(", ") },
              { label: "App", value: (c) => c.app ?? "" },
              { label: "Owner", value: (c) => owners(c).join(", ") || c.owner || "" },
              { label: "Who can run it", value: (c) => runners(c), render: (c) => runners(c) || <span className="muted">—</span> },
              { label: "Used", value: (c) => (c.usage?.runs ?? 0) + (c.usage?.views ?? 0) + schedRuns(c), render: (c) => {
                const u = c.usage;
                const parts = [u?.runs ? `${u.runs} runs` : "", schedRuns(c) ? `${schedRuns(c)} scheduled runs` : "", u?.views ? `${u.views} views` : ""].filter(Boolean);
                return parts.join(", ") || <span className="muted">not in the window</span>;
              } },
            ]}
          />
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
