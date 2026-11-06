import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { EntityType, Product } from "../generated/catalog";
import { EntityRow } from "../components/EntityBits";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel } from "../lib/labels";

const PAGE = 200;

export function SearchPage() {
  const { catalog, search } = useCatalog();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "";
  const product = params.get("product") ?? "";
  const app = params.get("app") ?? "";

  const results = useMemo(
    () => search.search(q, { type, product, app }),
    [search, q, type, product, app],
  );
  const types = [...catalog.countBy("type").keys()].sort();
  const products = [...catalog.countBy("product").keys()];
  const apps = [...new Set(catalog.entities.map((e) => e.app).filter(Boolean))].sort() as string[];

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack">
      <h1>{q ? <>Results for “{q}”</> : "Browse"}</h1>
      <div className="filters">
        <label>
          Type
          <select value={type} onChange={(e) => set("type", e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>{pluralTypeLabel(t as EntityType)}</option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select value={product} onChange={(e) => set("product", e.target.value)}>
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p} value={p}>{PRODUCT_LABELS[p as Product]}</option>
            ))}
          </select>
        </label>
        <label>
          App
          <select value={app} onChange={(e) => set("app", e.target.value)}>
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        {results.length.toLocaleString()} result{results.length === 1 ? "" : "s"}
        {results.length > PAGE && ` — showing the first ${PAGE}`}
      </p>
      <ul className="entity-list">
        {results.slice(0, PAGE).map((e) => (
          <EntityRow key={e.id} entity={e} />
        ))}
      </ul>
    </div>
  );
}
