import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AnnotationsTab } from "../components/AnnotationsTab";
import { DataSources } from "../components/DataSources";
import { DetectionPanel } from "../components/DetectionPanel";
import { GovernancePanel } from "../components/GovernancePanel";
import { UsagePanel } from "../components/UsagePanel";
import { isDetection } from "../lib/coverage";
import { AnnotationChips, TypeBadge } from "../components/EntityBits";
import { FieldsTab, fieldsTable } from "../components/FieldsTab";
import { LineageTab } from "../components/LineageTab";
import { hasLineage } from "../lib/lineage";
import { PropValue } from "../components/PropValue";
import { useCatalog } from "../lib/CatalogContext";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { relationGroups, type RelationGroup } from "../lib/relations";
import { entityPath, searchPath } from "../lib/routes";

/** Properties shown as code blocks rather than in the property table. */
const CODE: Record<string, string> = {
  search: "SPL",
  definition: "Definition",
  expression: "Eval expression",
  REGEX: "Regex",
  srchFilter: "Search filter",
  linkUri: "Link URI",
  query: "SQL",
};

const GROUP_LIMIT = 25;

function Group({ group }: { group: RelationGroup }) {
  const [all, setAll] = useState(false);
  const shown = all ? group.entities : group.entities.slice(0, GROUP_LIMIT);
  return (
    <div className="rel-group">
      <h3>
        {group.label} <span className="muted">({group.entities.length})</span>
      </h3>
      <ul className="plain-list">
        {shown.map((e) => (
          <li key={e.id}>
            <span className="muted rel-type">{typeLabel(e.type)}</span>{" "}
            <Link to={entityPath(e.id)}>{e.displayName ?? e.name}</Link>
            {e.app && <span className="muted"> · {e.app}</span>}
          </li>
        ))}
      </ul>
      {group.entities.length > GROUP_LIMIT && (
        <button type="button" className="btn btn-small" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${group.entities.length}`}
        </button>
      )}
    </div>
  );
}

type Tab = "overview" | "fields" | "lineage" | "relationships" | "annotations" | "raw";

export function EntityPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { catalog } = useCatalog();
  const entity = catalog.byId.get(id);

  if (!entity) {
    return (
      <div className="stack">
        <h1>Not found</h1>
        <p>No object with id <code>{id}</code> is in this bundle.</p>
      </div>
    );
  }

  const { observed, ...props } = (entity.properties ?? {}) as Record<string, unknown>;
  const code = Object.entries(props).filter(([k, v]) => k in CODE && typeof v === "string" && v);
  const DETECTION_KEYS = new Set(["mitreAttack", "killChainPhases", "analyticStories", "securityDomain", "severity", "dataModels"]);
  const rest = Object.entries(props).filter(([k]) => !(k in CODE) && !(isDetection(entity) && DETECTION_KEYS.has(k)));
  const groups = relationGroups(catalog, entity.id);
  const relCount = groups.reduce((n, g) => n + g.entities.length, 0);
  const fields = fieldsTable(catalog, entity);
  const ownerUser = entity.owner ? catalog.byId.get(`${entity.instance}:user:${entity.owner}`) : undefined;
  const instance = catalog.bundle.instances.find((i) => i.id === entity.instance);
  const a = entity.annotations;

  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ...(fields ? [["fields", `Fields (${fields.rows.length})`] as [Tab, string]] : []),
    ...(hasLineage(catalog, entity.id) || entity.lineage
      ? [["lineage", entity.lineage?.unresolved?.length ? "Lineage ⚠" : "Lineage"] as [Tab, string]]
      : []),
    ["relationships", `Relationships (${relCount})`],
    ["annotations", "Annotations"],
    ["raw", "Raw"],
  ];
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some(([t]) => t === requested) ? requested! : "overview";
  const selectTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "overview") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack">
      <div>
        <TypeBadge entity={entity} />
        <h1 className="entity-title">{entity.displayName ?? entity.name}</h1>
        {entity.displayName && entity.displayName !== entity.name && (
          <div className="muted"><code>{entity.name}</code></div>
        )}
        <p className="fqn"><code>{entity.id}</code></p>
        {a?.description ? (
          <p className="lede">{a.description}</p>
        ) : entity.description ? (
          <p className="lede">{entity.description}</p>
        ) : (
          <p className="muted">
            No description.{" "}
            <button type="button" className="link-btn" onClick={() => selectTab("annotations")}>Add one</button>
          </p>
        )}
        {a?.description && entity.description && a.description !== entity.description && (
          <p className="muted small">In Splunk: {entity.description}</p>
        )}
        <AnnotationChips entity={entity} />
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`tab${tab === t ? " tab-active" : ""}`} onClick={() => selectTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="stack">
          <dl className="facts">
            <dt>Product</dt>
            <dd><Link to={searchPath({ product: entity.product })}>{PRODUCT_LABELS[entity.product]}</Link></dd>
            <dt>Instance</dt><dd>{instance?.name ?? entity.instance}</dd>
            {entity.app && (<><dt>App</dt><dd><Link to={searchPath({ app: entity.app })}>{entity.app}</Link></dd></>)}
            {entity.owner && (
              <><dt>Splunk owner</dt><dd>{ownerUser ? <Link to={entityPath(ownerUser.id)}>{entity.owner}</Link> : entity.owner}</dd></>
            )}
            {entity.sharing && (<><dt>Sharing</dt><dd>{entity.sharing}</dd></>)}
            <dt>Status</dt><dd>{entity.disabled ? "Disabled" : "Enabled"}</dd>
            {entity.updatedAt && (<><dt>Updated in Splunk</dt><dd>{new Date(entity.updatedAt).toLocaleString()}</dd></>)}
            {entity.version !== undefined && (
              <>
                <dt>Catalog version</dt>
                <dd>
                  v{entity.version}
                  {entity.firstSeenAt && <span className="muted"> · first seen {new Date(entity.firstSeenAt).toLocaleDateString()}</span>}
                </dd>
              </>
            )}
          </dl>

          {isDetection(entity) && <DetectionPanel catalog={catalog} entity={entity} />}

          <GovernancePanel catalog={catalog} entity={entity} />

          <UsagePanel entity={entity} />

          {(entity.type === "index" || entity.type === "sourcetype") && (
            <DataSources catalog={catalog} entity={entity} />
          )}

          {a?.links?.length ? (
            <section>
              <h2>Links</h2>
              <ul className="plain-list">
                {a.links.map((l) => (
                  <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.title ?? l.url}</a></li>
                ))}
              </ul>
            </section>
          ) : null}

          {code.map(([k, v]) => (
            <section key={k}>
              <h2>{CODE[k]}</h2>
              <pre className="code">{v as string}</pre>
            </section>
          ))}

          {rest.length > 0 && (
            <section>
              <h2>Properties</h2>
              <dl className="facts">
                {rest.map(([k, v]) => (
                  <div key={k} className="fact-pair"><dt>{k}</dt><dd><PropValue value={v} /></dd></div>
                ))}
              </dl>
            </section>
          )}

          {observed !== undefined && (
            <section>
              <h2>Observed</h2>
              <p className="muted small">Measured when the bundle was generated ({new Date(catalog.bundle.generatedAt).toLocaleString()}).</p>
              <PropValue value={Object.fromEntries(Object.entries((observed ?? {}) as Record<string, unknown>)
            .filter(([k]) => k !== "dailyEvents"))} />
            </section>
          )}
        </div>
      )}

      {tab === "fields" && fields && <FieldsTab table={fields} />}

      {tab === "lineage" && <LineageTab catalog={catalog} entity={entity} />}

      {tab === "relationships" && (
        groups.length === 0 ? (
          <p className="muted">No relationships found.</p>
        ) : (
          <div className="rel-grid">
            {groups.map((g) => <Group key={`${g.direction}:${g.edgeType}`} group={g} />)}
          </div>
        )
      )}

      {tab === "annotations" && <AnnotationsTab entity={entity} source={catalog.bundle.annotationSource} />}

      {tab === "raw" && <pre className="code raw">{JSON.stringify(entity, null, 2)}</pre>}
    </div>
  );
}
