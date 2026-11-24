import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { actionLabel, type IndexTimeAction, type IndexTimeRule } from "../lib/indexTime";

/** Index-time rules: on a sourcetype, what its props.conf rules do to its events
 * (routed, dropped, forwarded, masked); on a transform, what it does and where it applies. */
export function IndexTimePanel({ entity }: { entity: Entity }) {
  const { catalog } = useCatalog();
  const p = (entity.properties ?? {}) as Record<string, unknown>;
  const transformLink = (name: string, app?: string) => {
    const same = catalog.find(entity.instance, "transform", name);
    const t = same.find((e) => !app || e.app === app);
    return t ? <Link to={`/entity/${encodeURIComponent(t.id)}`}>{name}</Link> : <code>{name}</code>;
  };
  if (entity.type === "transform") {
    const actions = (p.indexTime ?? []) as IndexTimeAction[];
    const applies = (p.appliesTo ?? []) as string[];
    if (!actions.length) return null;
    return (
      <section>
        <h2>Index time</h2>
        <ul className="plain-list">
          {actions.map((a, i) => (
            <li key={i}>
              {actionLabel(a.action)}
              {a.conditional ? " (when its condition matches)" : ""}
              {a.targets?.length ? <>: <code>{a.targets.join(", ")}</code></> : null}
              {a.field ? <> <code>{a.field}</code></> : null}
            </li>
          ))}
        </ul>
        {applies.length > 0 && <p className="muted">Applies to {applies.map((s) => <code key={s}>{s} </code>)}</p>}
      </section>
    );
  }
  const rules = (p.indexTime ?? []) as IndexTimeRule[];
  if (!rules.length) return null;
  return (
    <section>
      <h2>Index-time routing and filtering</h2>
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr><th>Rule</th><th>Transform</th><th>What happens</th><th>To</th></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td><code>{r.rule}</code></td>
                <td>{r.transform ? transformLink(r.transform, r.app) : "—"}</td>
                <td>{r.action === "mask" ? actionLabel("mask") : (r.actions ?? []).map(actionLabel).join(", ") || "—"}</td>
                <td>{r.targets?.length ? <code>{r.targets.join(", ")}</code> : r.sed ? <code>{r.sed}</code> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
