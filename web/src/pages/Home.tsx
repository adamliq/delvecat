import { Link } from "react-router-dom";
import type { EntityType } from "../generated/catalog";
import { PropValue } from "../components/PropValue";
import { effectiveDescription } from "../lib/annotate";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel, typeLabel } from "../lib/labels";
import { entityPath, searchPath } from "../lib/routes";

const KIND_LABELS: Record<string, string> = {
  splunkEnterprise: "Splunk Enterprise",
  splunkCloud: "Splunk Cloud",
  soar: "SOAR",
  uba: "UBA",
  deploymentServer: "Deployment Server",
};

const CHANGE_LIMIT = 15;

function ChangeList({ ids, label }: { ids: string[]; label: string }) {
  const { catalog } = useCatalog();
  if (!ids.length) return null;
  return (
    <div>
      <h3>{label} <span className="muted">({ids.length})</span></h3>
      <ul className="plain-list">
        {ids.slice(0, CHANGE_LIMIT).map((id) => {
          const e = catalog.byId.get(id);
          return (
            <li key={id}>
              {e ? (<><span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={entityPath(id)}>{e.displayName ?? e.name}</Link></>) : id}
            </li>
          );
        })}
        {ids.length > CHANGE_LIMIT && <li className="muted">…and {ids.length - CHANGE_LIMIT} more</li>}
      </ul>
    </div>
  );
}

export function Home() {
  const { catalog } = useCatalog();
  const { bundle } = catalog;
  const byType = [...catalog.countBy("type").entries()].sort((a, b) => b[1] - a[1]);
  const byProduct = [...catalog.countBy("product").entries()];
  const report = bundle.ingestionReport ?? [];
  const notOk = report.filter((r) => r.status !== "ok");
  const changes = bundle.changes;
  const total = bundle.entities.length || 1;
  const described = bundle.entities.filter((e) => effectiveDescription(e)).length;
  const owned = bundle.entities.filter((e) => e.annotations?.owners?.length).length;
  const classified = bundle.entities.filter((e) => e.annotations?.classifications?.length).length;
  const coverage: [string, number][] = [
    ["have a description", described],
    ["have an owner", owned],
    ["are classified", classified],
  ];

  return (
    <div className="stack">
      <section>
        <h1>Catalog overview</h1>
        <p className="lede">
          {bundle.entities.length.toLocaleString()} objects and {bundle.edges.length.toLocaleString()} relationships
          across {bundle.instances.length} instance{bundle.instances.length === 1 ? "" : "s"}.
        </p>
      </section>

      <section>
        <h2>Instances</h2>
        <div className="cards">
          {bundle.instances.map((i) => (
            <div key={i.id} className="card">
              <div className="card-title">{i.name}</div>
              <div className="muted">
                {KIND_LABELS[i.kind] ?? i.kind}
                {i.version && <> · {i.version}</>}
              </div>
              {i.roles?.length ? <p className="small">Roles: {i.roles.join(", ")}</p> : null}
              {i.properties && Object.keys(i.properties).length > 0 && (
                <details>
                  <summary>Details</summary>
                  <PropValue value={i.properties} />
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Documentation</h2>
        <div className="tiles">
          {coverage.map(([label, n]) => (
            <div key={label} className="tile static">
              <span className="tile-num">{Math.round((n / total) * 100)}%</span>
              <span className="tile-label">{label} ({n.toLocaleString()})</span>
            </div>
          ))}
        </div>
        <p className="small">
          <Link to={searchPath({ documented: "no" })}>Find objects without a description</Link> ·{" "}
          <Link to="/glossary">Glossary ({(bundle.glossary ?? []).length} terms)</Link>
        </p>
      </section>

      <section>
        <h2>Object types</h2>
        <div className="tiles">
          {byType.map(([type, n]) => (
            <Link key={type} to={searchPath({ type })} className="tile">
              <span className="tile-num">{n.toLocaleString()}</span>
              <span className="tile-label">{pluralTypeLabel(type as EntityType)}</span>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2>Products</h2>
        <ul className="plain-list">
          {byProduct.map(([product, n]) => (
            <li key={product}>
              <Link to={searchPath({ product })}>{PRODUCT_LABELS[product]}</Link> — {n.toLocaleString()} objects
            </li>
          ))}
        </ul>
      </section>

      {changes && (
        <section>
          <h2>Changes since {new Date(changes.previousGeneratedAt).toLocaleString()}</h2>
          {changes.added.length + changes.modified.length + changes.removed.length === 0 ? (
            <p className="muted">No changes.</p>
          ) : (
            <div className="rel-grid">
              <ChangeList ids={changes.added} label="Added" />
              <ChangeList ids={changes.modified} label="Modified" />
              {changes.removed.length > 0 && (
                <div>
                  <h3>Removed <span className="muted">({changes.removed.length})</span></h3>
                  <ul className="plain-list">
                    {changes.removed.slice(0, CHANGE_LIMIT).map((r) => (
                      <li key={r.id}><span className="muted rel-type">{typeLabel(r.type)}</span> {r.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {report.length > 0 && (
        <section>
          <h2>Ingestion report</h2>
          {notOk.length === 0 && <p className="muted">All {report.length} extractors completed.</p>}
          <details open={notOk.length > 0}>
            <summary>{notOk.length ? `${notOk.length} extractor(s) need attention` : "Show all extractors"}</summary>
            <div className="table-wrap">
              <table className="mini-table">
                <thead><tr><th>Extractor</th><th>Status</th><th>Counts</th><th>Notes</th></tr></thead>
                <tbody>
                  {[...notOk, ...report.filter((r) => r.status === "ok")].map((r) => (
                    <tr key={r.connector}>
                      <td><code>{r.connector}</code></td>
                      <td><span className={`status status-${r.status}`}>{r.status}</span></td>
                      <td>{r.counts ? Object.entries(r.counts).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join(", ") : ""}</td>
                      <td>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
