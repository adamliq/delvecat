import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { EntityType, Product } from "../generated/catalog";
import { EntityRow } from "../components/EntityBits";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel } from "../lib/labels";
import { FACET_NAMES, type Facet, type Filters, type Sort } from "../lib/search";

const PAGE = 50;
const FACET_PREVIEW = 8;

const FACET_TITLES: Record<Facet, string> = {
  type: "Type",
  product: "Product",
  instance: "Instance",
  app: "App",
  domain: "Domain",
  dataProduct: "Data product",
  owner: "Owner",
  tag: "Tag",
  classification: "Classification",
  term: "Glossary term",
  sharing: "Sharing",
  status: "Status",
  documented: "Has description",
  issue: "Search issues",
  health: "Health",
  sensitivity: "Sensitivity",
  usage: "Usage",
};

let instanceNames: Record<string, string> = {};

function valueLabel(facet: Facet, value: string): string {
  if (facet === "instance") return instanceNames[value] ?? value;
  if (facet === "type") return pluralTypeLabel(value as EntityType);
  if (facet === "product") return PRODUCT_LABELS[value as Product] ?? value;
  return value;
}

function FacetBox({ facet, counts, selected, onToggle }: {
  facet: Facet;
  counts: Map<string, number>;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const entries = [...counts.entries()];
  // Keep selected values visible even when their count drops to zero.
  for (const s of selected) if (!counts.has(s)) entries.push([s, 0]);
  if (!entries.length) return null;
  const shown = open ? entries : entries.slice(0, FACET_PREVIEW);
  return (
    <fieldset className="facet">
      <legend>{FACET_TITLES[facet]}</legend>
      {shown.map(([value, n]) => (
        <label key={value} className="facet-option">
          <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
          <span className="facet-label">{valueLabel(facet, value)}</span>
          <span className="facet-count">{n.toLocaleString()}</span>
        </label>
      ))}
      {entries.length > FACET_PREVIEW && (
        <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}
    </fieldset>
  );
}

export function SearchPage() {
  const { search, catalog } = useCatalog();
  instanceNames = Object.fromEntries(catalog.bundle.instances.map((i) => [i.id, i.name]));
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(PAGE);
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") as Sort) || "relevance";
  const filters: Filters = useMemo(() => {
    const f: Filters = {};
    for (const name of FACET_NAMES) {
      const values = params.getAll(name);
      if (values.length) f[name] = values;
    }
    return f;
  }, [params]);

  const { results, facets } = useMemo(() => search.query(q, filters, sort), [search, q, filters, sort]);
  const activeCount = Object.values(filters).reduce((n, v) => n + (v?.length ?? 0), 0);

  const update = (fn: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    fn(next);
    setLimit(PAGE);
    setParams(next, { replace: true });
  };
  const toggle = (facet: Facet, value: string) =>
    update((next) => {
      const values = next.getAll(facet);
      next.delete(facet);
      const updated = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
      updated.forEach((v) => next.append(facet, v));
    });
  const clearAll = () => update((next) => FACET_NAMES.forEach((f) => next.delete(f)));

  const facetPanel = (
    <div className="facets">
      {FACET_NAMES.map((f) => (
        <FacetBox key={f} facet={f} counts={facets[f]} selected={filters[f] ?? []} onToggle={(v) => toggle(f, v)} />
      ))}
    </div>
  );

  return (
    <div className="search-layout">
      <aside className="search-sidebar">
        <details className="facets-mobile">
          <summary>Filters{activeCount ? ` (${activeCount})` : ""}</summary>
          {facetPanel}
        </details>
        <div className="facets-desktop">{facetPanel}</div>
      </aside>
      <div className="stack search-main">
        <h1>{q ? <>Results for “{q}”</> : "Browse the catalog"}</h1>
        {activeCount > 0 && (
          <div className="active-filters">
            {FACET_NAMES.flatMap((f) =>
              (filters[f] ?? []).map((v) => (
                <button key={`${f}:${v}`} type="button" className="chip chip-remove" onClick={() => toggle(f, v)}
                  aria-label={`Remove filter ${FACET_TITLES[f]}: ${valueLabel(f, v)}`}>
                  {FACET_TITLES[f]}: {valueLabel(f, v)} ×
                </button>
              )),
            )}
            <button type="button" className="link-btn" onClick={clearAll}>Clear all</button>
          </div>
        )}
        <div className="results-bar">
          <span className="muted">
            {results.length.toLocaleString()} result{results.length === 1 ? "" : "s"}
          </span>
          <label className="sort">
            Sort
            <select value={sort} onChange={(e) => update((next) => next.set("sort", e.target.value))}>
              <option value="relevance">{q ? "Relevance" : "Name"}</option>
              <option value="name">Name</option>
              <option value="type">Type</option>
              <option value="updated">Recently updated in Splunk</option>
            </select>
          </label>
        </div>
        <ul className="entity-list">
          {results.slice(0, limit).map((e) => <EntityRow key={e.id} entity={e} />)}
        </ul>
        {results.length > limit && (
          <button type="button" className="btn" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, results.length - limit)} more
          </button>
        )}
      </div>
    </div>
  );
}
