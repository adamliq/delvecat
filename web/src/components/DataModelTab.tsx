import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { datasetFields, datasetPath, datasetSearches, datasetsOf, type Calculation, type Dataset } from "../lib/dataModels";
import { typeLabel } from "../lib/labels";
import { entityPath } from "../lib/routes";
import { DataTable } from "./DataTable";
import { LazyDetails } from "./LazyDetails";
import { SplCode } from "./SplCode";

function lookupLink(catalog: Catalog, model: Entity, name: string) {
  const target = catalog.edgesFrom(model.id).map((x) => catalog.byId.get(x.to)).find((e) => e?.type === "lookup" && e.name === name);
  return target ? <Link to={entityPath(target.id)}>{name}</Link> : <code>{name}</code>;
}

function CalculationRow({ catalog, model, c }: { catalog: Catalog; model: Entity; c: Calculation }) {
  const outs = (c.outputs ?? []).map((o, i) => <span key={o}>{i > 0 && ", "}<code>{o}</code></span>);
  if (c.type === "lookup") {
    const inputs = Object.entries(c.lookupInputs ?? {}).map(([field, col]) => (field === col ? field : `${field} = ${col}`));
    return <li><strong>Lookup</strong> {c.lookup && lookupLink(catalog, model, c.lookup)} on <code>{inputs.join(", ") || "?"}</code> gives {outs}</li>;
  }
  return (
    <li>
      <strong>{c.type === "geoip" ? "GeoIP" : c.type === "rex" ? "Regular expression" : "Eval"}</strong>
      {c.inputField && <> of <code>{c.inputField}</code></>} gives {outs}
      {c.expression && <pre className="code small">{c.expression}</pre>}
    </li>
  );
}

function DatasetPanel({ catalog, model, d }: { catalog: Catalog; model: Entity; d: Dataset }) {
  const fields = datasetFields(model, d); // cheap; the table itself is built when opened
  const searches = datasetSearches(catalog, model, d);
  const own = fields.filter((f) => !f.inherited).length;
  return (
    <LazyDetails
      className="dataset"
      summary={<><strong>{d.displayName ?? d.name}</strong> <span className="muted small">{datasetPath(d)} · {fields.length} fields ({own} its own){searches.length > 0 && ` · ${searches.length} search${searches.length === 1 ? "" : "es"}`}</span></>}
    >
      {() => (
      <div className="stack">
        {d.comment && <p>{d.comment}</p>}
        <dl className="facts">
          <dt>Inherits from</dt><dd>{d.parent ?? "—"}</dd>
          <dt>Constraint</dt><dd>{d.constraint ? <SplCode text={d.constraint} catalog={catalog} entity={model} /> : <span className="muted">none (all of the parent's events)</span>}</dd>
          <dt>Searched by</dt>
          <dd>{searches.length ? searches.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link to={entityPath(s.id)}>{s.displayName ?? s.name}</Link> <span className="muted small">({typeLabel(s.type)})</span></span>)
            : <span className="muted">no search in the catalog names this dataset</span>}</dd>
        </dl>
        {(d.calculations?.length ?? 0) > 0 && (
          <section>
            <h3>Calculations</h3>
            <ul className="plain-list">{d.calculations!.map((c, i) => <CalculationRow key={i} catalog={catalog} model={model} c={c} />)}</ul>
          </section>
        )}
        <DataTable
          rows={fields}
          rowKey={(f) => f.name}
          csvName={`${model.name}-${d.name}-fields.csv`}
          columns={[
            { label: "Field", value: (f) => f.name, render: (f) => <><code>{f.name}</code>{f.displayName && <span className="muted small"> {f.displayName}</span>}</> },
            { label: "Type", value: (f) => f.type ?? "" },
            { label: "Flags", value: (f) => [f.required && "required", f.multivalue && "multivalue", f.hidden && "hidden"].filter(Boolean).join(", ") },
            { label: "Calculated", value: (f) => f.calculation ?? "", render: (f) => f.calculation ?? <span className="muted">—</span> },
            { label: "Defined in", value: (f) => f.from, render: (f) => (f.inherited ? <span className="muted">{f.from}</span> : "this dataset") },
          ]}
        />
      </div>
      )}
    </LazyDetails>
  );
}

/** A data model's datasets: constraint, fields with types and where they come from,
 * calculations, and the searches that name each dataset. */
export function DataModelTab({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const datasets = datasetsOf(entity);
  return (
    <section className="stack">
      <p className="muted small">Each dataset lists its own fields and those it inherits. Searches are linked to a dataset when they name it
        (<code>from datamodel=Model.Dataset</code>, <code>nodename=</code>, <code>| datamodel Model Dataset</code>, <code>| pivot</code>).</p>
      {datasets.map((d) => <DatasetPanel key={datasetPath(d)} catalog={catalog} model={entity} d={d} />)}
    </section>
  );
}
