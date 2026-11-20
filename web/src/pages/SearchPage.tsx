import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Entity, EntityType, Product } from "../generated/catalog";
import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { EntityRow } from "../components/EntityBits";
import { effectiveDescription, owners } from "../lib/annotate";
import { entityPath } from "../lib/routes";
import { StatusLabel } from "./HealthPage";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, pluralTypeLabel, TYPE_GROUPS, typeGroup, typeLabel } from "../lib/labels";
import { type Facet, type Filters, type Sort } from "../lib/search";
import { exportFileName, resultRows } from "../lib/exportResults";
import { downloadText, toCsv } from "../lib/health";
import { riskMap } from "../lib/risk";
import { label, propertyDefs } from "../lib/structured";

const PAGE = 50;
const FACET_PREVIEW = 8;

const FACET_TITLES: Record<string, string> = {
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
  missing: "Missing required property",
  risk: "At risk from upstream problems",
  quality: "Data quality",
  health: "Health",
  sensitivity: "Sensitivity",
  usage: "Usage",
};

let instanceNames: Record<string, string> = {};
let propertyNames: Record<string, string> = {};
const facetTitle = (f: Facet): string => FACET_TITLES[f] ?? propertyNames[f.replace(/^p\./, "")] ?? f;

function valueLabel(facet: Facet, value: string): string {
  if (facet === "instance") return instanceNames[value] ?? value;
  if (facet === "missing") return propertyNames[value] ?? value;
  if (facet === "risk") return value === "critical" ? "Critical" : "Warning";
  if (facet === "type") return pluralTypeLabel(value as EntityType);
  if (facet === "product") return PRODUCT_LABELS[value as Product] ?? value;
  return value;
}

/** Type values grouped by area, in the order of TYPE_GROUPS; "Other" last. */
function groupTypes(entries: [string, number][]): [string, [string, number][]][] {
  const order = [...TYPE_GROUPS.map(([g]) => g), "Other"];
  const groups = new Map<string, [string, number][]>();
  for (const e of entries) {
    const g = typeGroup(e[0]);
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  return order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g)!]);
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
      <legend>{facetTitle(facet)}</legend>
      {(facet === "type" && open ? groupTypes(entries) : [["", shown] as [string, [string, number][]]]).map(([group, items]) => (
        <div key={group || "all"} className={group ? "facet-group" : undefined}>
          {group && <div className="facet-group-title">{group}</div>}
          {items.map(([value, n]) => (
            <label key={value} className="facet-option">
              <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
              <span className="facet-label">{valueLabel(facet, value)}</span>
              <span className="facet-count">{n.toLocaleString()}</span>
            </label>
          ))}
        </div>
      ))}
      {entries.length > FACET_PREVIEW && (
        <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}
    </fieldset>
  );
}

/** Results as a compact sortable table, to scan many at once. */
function ResultTable({ results, instances }: { results: Entity[]; instances: Record<string, string> }) {
  const many = Object.keys(instances).length > 1;
  return (
    <DataTable
      rows={results}
      rowKey={(e) => e.id}
      limit={500}
      className="mini-table result-table"
      columns={[
        { label: "Type", value: (e) => typeLabel(e.type) },
        { label: "Name", value: (e) => e.displayName ?? e.name, render: (e) => <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link> },
        ...(many ? [{ label: "Instance", value: (e: Entity) => instances[e.instance] ?? e.instance }] : []),
        { label: "App", value: (e) => e.app ?? "" },
        { label: "Owner", value: (e) => owners(e).join(", ") || e.owner || "" },
        { label: "Health", value: (e) => e.health?.status ?? "", render: (e) => (e.health ? <StatusLabel status={e.health.status} /> : <span className="muted">—</span>) },
        { label: "Updated", value: (e) => e.updatedAt ?? "", render: (e) => (e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : "—") },
        { label: "Description", value: (e) => effectiveDescription(e) ?? "", render: (e) => <span className="clamp-2">{effectiveDescription(e) ?? ""}</span> },
      ]}
    />
  );
}

export function SearchPage() {
  const { search, catalog } = useCatalog();
  instanceNames = Object.fromEntries(catalog.bundle.instances.map((i) => [i.id, i.name]));
  propertyNames = Object.fromEntries(propertyDefs(catalog.bundle).map((d) => [d.id, label(d)]));
  const FACET_NAMES = search.facetNames;
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

  const { results, facets, matches } = useMemo(() => search.query(q, filters, sort), [search, q, filters, sort]);
  const view = params.get("view") === "table" ? "table" : "list";
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
  const exportCsv = () => downloadText(exportFileName(q), toCsv(resultRows(results, {
    instanceNames, defs: propertyDefs(catalog.bundle), risk: riskMap(catalog), baseUrl: window.location.href.split("#")[0],
  })));
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
                  aria-label={`Remove filter ${facetTitle(f)}: ${valueLabel(f, v)}`}>
                  {facetTitle(f)}: {valueLabel(f, v)} ×
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
          <div className="results-actions">
            <button type="button" className="btn btn-small" onClick={exportCsv} disabled={!results.length}
              title="Every result, with annotations, health and structured properties">
              Download CSV
            </button>
            <div className="seg" role="group" aria-label="View">
              {(["list", "table"] as const).map((v) => (
                <button key={v} type="button" className={view === v ? "active" : undefined} aria-pressed={view === v}
                  onClick={() => update((next) => (v === "list" ? next.delete("view") : next.set("view", v)))}>
                  {v === "list" ? "List" : "Table"}
                </button>
              ))}
            </div>
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
        </div>
        {view === "table" ? (
          <ResultTable results={results} instances={instanceNames} />
        ) : (
          <ul className="entity-list">
            {results.slice(0, limit).map((e) => <EntityRow key={e.id} entity={e} match={matches.get(e.id)} />)}
          </ul>
        )}
        {view === "list" && results.length > limit && (
          <button type="button" className="btn" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, results.length - limit)} more
          </button>
        )}
      </div>
    </div>
  );
}
