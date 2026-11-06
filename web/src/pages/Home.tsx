import { Link } from "react-router-dom";
import type { EntityType } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel } from "../lib/labels";
import { searchPath } from "../lib/routes";

export function Home() {
  const { catalog } = useCatalog();
  const { bundle } = catalog;
  const byType = [...catalog.countBy("type").entries()].sort((a, b) => b[1] - a[1]);
  const byProduct = [...catalog.countBy("product").entries()];
  const problems = (bundle.ingestionReport ?? []).filter((r) => r.status !== "ok");

  return (
    <div className="stack">
      <section>
        <h1>Catalog overview</h1>
        <p className="lede">
          {bundle.entities.length.toLocaleString()} objects across {bundle.instances.length} instance
          {bundle.instances.length === 1 ? "" : "s"} ({bundle.instances.map((i) => i.name).join(", ")}).
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

      {problems.length > 0 && (
        <section>
          <h2>Ingestion notes</h2>
          <ul className="plain-list">
            {problems.map((r) => (
              <li key={r.connector}>
                <code>{r.connector}</code> <span className={`status status-${r.status}`}>{r.status}</span>{" "}
                {r.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
