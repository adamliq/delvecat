import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import {
  derivedFrom, fieldDefiners, fieldImpact, fieldName, fieldReaders, HOW_LABELS, SOURCE_LABELS, usedFields, type FieldHow,
} from "../lib/fieldLineage";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";

const name = (e: Entity) => e.displayName ?? e.name;
const sourcetypeOf = (f: Entity) => String((f.properties as { sourcetype?: unknown } | undefined)?.sourcetype ?? "");

function Hows({ how }: { how: FieldHow[] }) {
  return <span className="chips">{how.map((h) => <span key={h} className={`chip how-chip how-${h}`}>{HOW_LABELS[h]}</span>)}</span>;
}

function Obj({ e }: { e: Entity }) {
  return <><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(e.id)}>{name(e)}</Link></>;
}

/** Fields a search uses and where each result column comes from. */
export function SearchFieldsTab({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const fl = entity.lineage?.fields;
  if (!fl) return null;
  const used = usedFields(catalog, entity);
  const byName = new Map(used.map((u) => [u.name, u]));
  const fieldLink = (n: string) => {
    const f = byName.get(n)?.fields[0];
    return f ? <Link to={entityPath(f.id)}><code>{n}</code></Link> : <code>{n}</code>;
  };
  return (
    <div className="stack">
      <section>
        <h2>Fields read <span className="muted">({used.length})</span></h2>
        <p className="muted small">
          Worked out from the SPL (macros expanded): {SOURCE_LABELS[fl.source]}, and how the search uses them.
          {fl.source === "events" && " Each is matched to the fields of the sourcetypes the search reads."}
        </p>
        {used.length === 0 ? <p className="muted">No fields are referenced.</p> : (
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Field</th><th>Used to</th>{fl.source === "events" && <th>Found in</th>}</tr></thead>
              <tbody>
                {used.map((u) => (
                  <tr key={u.name}>
                    <td><code>{u.name}</code></td>
                    <td><Hows how={u.how} /></td>
                    {fl.source === "events" && (
                      <td>
                        {u.fields.length ? u.fields.map((f, i) => (
                          <span key={f.id}>{i > 0 && ", "}<Link to={entityPath(f.id)}>{sourcetypeOf(f) || name(f)}</Link></span>
                        )) : <span className="muted small">not seen on the sourcetypes it reads</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {fl.outputs && fl.outputs.length > 0 && (
        <section>
          <h2>Result columns <span className="muted">({fl.outputs.length})</span></h2>
          <p className="muted small">Each column of the results and the source fields it is computed from.</p>
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Column</th><th>Computed from</th></tr></thead>
              <tbody>
                {fl.outputs.map((o) => (
                  <tr key={o.name}>
                    <td><code>{o.name}</code></td>
                    <td>
                      {o.from.length === 0 ? <span className="muted small">no source fields (a count, time or constant)</span>
                        : o.from.length === 1 && o.from[0] === o.name ? <>{fieldLink(o.name)} <span className="muted small">as is</span></>
                        : o.from.map((f, i) => <span key={f}>{i > 0 && ", "}{fieldLink(f)}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

const SHOWN = 15;

/** On a field: where it comes from, what reads it, and what a change to it could break. */
export function FieldPanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  if (entity.type !== "field") return null;
  const definers = fieldDefiners(catalog, entity);
  const sources = derivedFrom(catalog, entity);
  const readers = fieldReaders(catalog, entity);
  const impact = fieldImpact(catalog, entity);
  const sampled = (entity.properties as { definedIn?: string } | undefined)?.definedIn !== "configuration";
  const st = catalog.byId.get(`${entity.instance}:sourcetype:${sourcetypeOf(entity)}`);
  return (
    <>
      <section>
        <h2>Where <code>{fieldName(entity)}</code> comes from</h2>
        <dl className="facts">
          {st && <><dt>Sourcetype</dt><dd><Link to={entityPath(st.id)}>{name(st)}</Link></dd></>}
          <dt>Defined by</dt>
          <dd>
            {definers.length ? definers.map((d) => <div key={d.id}><Obj e={d} /></div>)
              : <span className="muted">{sampled ? "seen in sampled events (automatic extraction or indexed)" : "—"}</span>}
          </dd>
          {sources.length > 0 && (
            <><dt>Derived from</dt><dd>{sources.map((f, i) => <span key={f.id}>{i > 0 && ", "}<Link to={entityPath(f.id)}><code>{fieldName(f)}</code></Link></span>)}</dd></>
          )}
        </dl>
      </section>

      <section>
        <h2>Used by <span className="muted">({readers.length})</span></h2>
        {readers.length === 0 ? (
          <p className="muted">No search in the catalog reads this field.</p>
        ) : (
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Object</th><th>Used to</th></tr></thead>
              <tbody>
                {readers.map((r) => (
                  <tr key={r.entity.id}>
                    <td><Obj e={r.entity} />{r.entity.app && <div className="muted small">{r.entity.app}</div>}</td>
                    <td>
                      {r.how.length ? <Hows how={r.how} /> : r.defines.length ? (
                        <span className="small">derive {r.defines.map((f, i) => <span key={f.id}>{i > 0 && ", "}<Link to={entityPath(f.id)}><code>{fieldName(f)}</code></Link></span>)}</span>
                      ) : <span className="muted small">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {impact.length > 0 && (
        <section>
          <h2>If this field changes or disappears <span className="muted">({impact.length})</span></h2>
          <p className="muted small">
            Objects that read it, fields derived from it and what reads them, and everything downstream of those.
          </p>
          <ul className="plain-list">
            {impact.slice(0, SHOWN).map((a) => <ImpactRow key={a.entity.id} a={a} />)}
          </ul>
          {impact.length > SHOWN && (
            <details>
              <summary className="small">{impact.length - SHOWN} more</summary>
              <ul className="plain-list">{impact.slice(SHOWN).map((a) => <ImpactRow key={a.entity.id} a={a} />)}</ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}

function ImpactRow({ a }: { a: ReturnType<typeof fieldImpact>[number] }) {
  return (
    <li>
      <Obj e={a.entity} />
      <span className="muted small">
        {" · "}{a.depth === 1 ? "reads it directly" : <>{a.depth} steps, via {typeLabel(a.via!.type).toLowerCase()} <Link to={entityPath(a.via!.id)}>{name(a.via!)}</Link></>}
      </span>
    </li>
  );
}
