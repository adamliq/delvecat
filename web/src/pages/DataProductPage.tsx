import { Link, useParams } from "react-router-dom";
import type { Entity, EntityType } from "../generated/catalog";
import { EntityRow } from "../components/EntityBits";
import { RollupTiles } from "../components/Rollup";
import { useCatalog } from "../lib/CatalogContext";
import { boundary, dataProducts, productAssets, rollup } from "../lib/domains";
import { pluralTypeLabel, typeLabel } from "../lib/labels";
import { domainPath, entityPath, searchPath } from "../lib/routes";

function Boundary({ title, items, empty }: { title: string; items: Entity[]; empty: string }) {
  return (
    <div className="rel-group">
      <h3>{title} <span className="muted">({items.length})</span></h3>
      {items.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="plain-list">
          {items.map((e) => (
            <li key={e.id}>
              <span className="muted rel-type">{typeLabel(e.type)}</span> <Link to={`${entityPath(e.id)}?tab=lineage`}>{e.displayName ?? e.name}</Link>
              {e.annotations?.domain && <span className="muted small"> · {e.annotations.domain}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DataProductPage() {
  const { name = "" } = useParams();
  const { catalog } = useCatalog();
  const product = dataProducts(catalog).find((p) => p.name === name);
  if (!product) {
    return <div className="stack"><h1>Not found</h1><p>No data product named <code>{name}</code> is in this bundle.</p></div>;
  }
  const assets = productAssets(catalog, product);
  const { inputs, consumers } = boundary(catalog, product);
  const types = [...new Set(assets.map((a) => a.type))].sort();
  return (
    <div className="stack">
      <div>
        <span className="badge">Data product</span>
        <h1>{product.name}</h1>
        {product.domain && <p className="small">Domain: <Link to={domainPath(product.domain)}>{product.domain}</Link></p>}
        {product.description && <p className="lede">{product.description}</p>}
        {product.owners?.length ? <p className="small">Owners: {product.owners.join(", ")}</p> : null}
        {product.links?.length ? (
          <ul className="plain-list small">{product.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.title ?? l.url}</a></li>)}</ul>
        ) : null}
      </div>
      <RollupTiles r={rollup(assets)} browse={searchPath({ dataProduct: product.name })} />
      <section className="rel-grid">
        <Boundary title="Depends on (outside the product)" items={inputs} empty="Nothing outside the product feeds it." />
        <Boundary title="Used by (outside the product)" items={consumers} empty="Nothing outside the product uses it." />
      </section>
      {types.map((t) => {
        const ofType = assets.filter((a) => a.type === t);
        return (
          <section key={t}>
            <h2>{pluralTypeLabel(t as EntityType)} <span className="muted">({ofType.length})</span></h2>
            <ul className="entity-list">{ofType.map((e) => <EntityRow key={e.id} entity={e} />)}</ul>
          </section>
        );
      })}
      {product.source && <p className="muted small">Defined in <code>{product.source}</code></p>}
    </div>
  );
}
