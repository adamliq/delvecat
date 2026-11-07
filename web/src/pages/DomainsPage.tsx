import { Link, useParams } from "react-router-dom";
import { EntityRow } from "../components/EntityBits";
import { RollupTiles } from "../components/Rollup";
import { useCatalog } from "../lib/CatalogContext";
import { dataProducts, domainAssets, domains, rollup, subtree, type Domain } from "../lib/domains";
import { domainPath, productPath, searchPath } from "../lib/routes";

const ASSET_LIMIT = 100;

function DomainTree({ items, parent, depth = 0 }: { items: Domain[]; parent?: string; depth?: number }) {
  const { catalog } = useCatalog();
  const level = items.filter((d) => (d.parent ?? undefined) === parent || (!parent && d.parent && !items.some((x) => x.name === d.parent)));
  if (!level.length || depth > 10) return null;
  return (
    <ul className={depth ? "domain-tree nested" : "domain-tree"}>
      {level.sort((a, b) => a.name.localeCompare(b.name)).map((d) => {
        const r = rollup(domainAssets(catalog, d.name));
        const products = dataProducts(catalog).filter((p) => subtree(catalog, d.name).has(p.domain ?? "")).length;
        return (
          <li key={d.name}>
            <div className="domain-card">
              <Link to={domainPath(d.name)} className="card-title">{d.name}</Link>
              {d.description && <div className="small">{d.description}</div>}
              <div className="muted small">
                {r.total} assets · {products} data product{products === 1 ? "" : "s"}
                {d.owners?.length ? <> · owned by {d.owners.join(", ")}</> : null}
                {r.critical + r.warning > 0 && <> · <span className="status-label status-warning">! {r.critical + r.warning} health findings</span></>}
              </div>
            </div>
            <DomainTree items={items} parent={d.name} depth={depth + 1} />
          </li>
        );
      })}
    </ul>
  );
}

export function DomainsPage() {
  const { name } = useParams();
  const { catalog } = useCatalog();
  const all = domains(catalog);

  if (!name) {
    const unassigned = catalog.entities.filter((e) => !e.annotations?.domain).length;
    return (
      <div className="stack">
        <div>
          <h1>Domains</h1>
          <p className="lede">Business areas that own Splunk data and content, and the data products they deliver.</p>
        </div>
        {all.length === 0 ? (
          <p className="muted">No domains are defined. Add <code>domains:</code> to a file in <code>annotations/</code> and assign objects with <code>domain:</code>.</p>
        ) : (
          <>
            <DomainTree items={all} />
            <p className="muted small">{unassigned.toLocaleString()} objects have no domain. <Link to={searchPath({})}>Browse</Link> and filter by Domain to review them.</p>
          </>
        )}
        {dataProducts(catalog).length > 0 && (
          <section>
            <h2>Data products</h2>
            <div className="cards">
              {dataProducts(catalog).map((p) => (
                <div key={p.name} className="card">
                  <Link to={productPath(p.name)} className="card-title">{p.name}</Link>
                  <div className="muted small">{p.domain ?? "No domain"} · {p.assets.length} assets{p.owners?.length ? ` · ${p.owners.join(", ")}` : ""}</div>
                  {p.description && <p className="small">{p.description}</p>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  const domain = all.find((d) => d.name === name);
  const children = all.filter((d) => d.parent === name);
  const assets = domainAssets(catalog, name);
  const own = assets.filter((e) => e.annotations?.domain === name);
  const products = dataProducts(catalog).filter((p) => subtree(catalog, name).has(p.domain ?? ""));
  return (
    <div className="stack">
      <div>
        <span className="badge">Domain</span>
        <h1>{name}</h1>
        {domain?.parent && <p className="small">Part of <Link to={domainPath(domain.parent)}>{domain.parent}</Link></p>}
        {domain?.description ? <p className="lede">{domain.description}</p> : !domain && <p className="muted">This domain is used on objects but not defined in the annotations.</p>}
        {domain?.owners?.length ? <p className="small">Owners: {domain.owners.join(", ")}</p> : null}
        {domain?.links?.length ? <p className="small">{domain.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.title ?? l.url} </a>)}</p> : null}
      </div>
      <RollupTiles r={rollup(assets)} browse={searchPath({ domain: [...subtree(catalog, name)] })} />
      {children.length > 0 && (
        <section>
          <h2>Sub-domains</h2>
          <ul className="plain-list">{children.map((c) => <li key={c.name}><Link to={domainPath(c.name)}>{c.name}</Link> <span className="muted small">{domainAssets(catalog, c.name).length} assets</span></li>)}</ul>
        </section>
      )}
      {products.length > 0 && (
        <section>
          <h2>Data products</h2>
          <div className="cards">
            {products.map((p) => (
              <div key={p.name} className="card">
                <Link to={productPath(p.name)} className="card-title">{p.name}</Link>
                <div className="muted small">{p.assets.length} assets{p.domain !== name ? ` · ${p.domain}` : ""}</div>
                {p.description && <p className="small">{p.description}</p>}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>Assets in this domain <span className="muted">({own.length}{assets.length > own.length ? `, ${assets.length} with sub-domains` : ""})</span></h2>
        <ul className="entity-list">{own.slice(0, ASSET_LIMIT).map((e) => <EntityRow key={e.id} entity={e} />)}</ul>
        {own.length > ASSET_LIMIT && <p className="small"><Link to={searchPath({ domain: name })}>See all {own.length}</Link></p>}
      </section>
    </div>
  );
}
