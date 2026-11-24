import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { CopyButton } from "../components/CopyButton";
import { rememberViewed } from "../lib/recent";
import type { Entity } from "../generated/catalog";
import { AnnotationsTab } from "../components/AnnotationsTab";
import { DataSources } from "../components/DataSources";
import { DetectionPanel } from "../components/DetectionPanel";
import { GovernancePanel } from "../components/GovernancePanel";
import { PropertiesPanel } from "../components/PropertiesPanel";
import { QualityTab } from "../components/QualityTab";
import { RelationGraph } from "../components/RelationGraph";
import { SchemaTab } from "../components/SchemaTab";
import { BlastRadius, RiskBanner } from "../components/RiskPanel";
import { UsagePanel } from "../components/UsagePanel";
import { StoragePanel } from "../components/StoragePanel";
import { IndexTimePanel } from "../components/IndexTimePanel";
import { isDetection } from "../lib/coverage";
import { AnnotationChips, TypeBadge } from "../components/EntityBits";
import { FieldPanel, SearchFieldsTab } from "../components/FieldLineage";
import { FieldsTab, fieldsTable } from "../components/FieldsTab";
import { LookupFieldsTab } from "../components/LookupFieldsTab";
import { DataModelTab } from "../components/DataModelTab";
import { CommandList } from "../components/CommandList";
import { DiffTable, type DiffRow } from "./ChangesPage";
import { lookupColumns } from "../lib/lookups";
import { LineageTab } from "../components/LineageTab";
import { hasLineage } from "../lib/lineage";
import { PropContext, PropValue } from "../components/PropValue";
import { SectionNav } from "../components/SectionNav";
import { SplCode } from "../components/SplCode";
import { propLabel } from "../lib/propertyFormat";
import { useCatalog } from "../lib/CatalogContext";
import { measuredAt } from "../lib/health";
import { PRODUCT_LABELS, typeLabel } from "../lib/labels";
import { relationGroups, type RelationGroup } from "../lib/relations";
import { entityPath, searchPath } from "../lib/routes";

/** Properties shown as code blocks rather than in the property table. */
const SPL_KEYS = new Set(["search", "definition", "srchFilter"]);
// Index settings the Storage and retention section already shows.
const STORAGE_KEYS = new Set([
  "retentionDays", "maxTotalDataSizeMB", "maxGlobalDataSizeMB", "frozenTimePeriodInSecs", "frozenAction",
  "homePath", "coldPath", "thawedPath", "coldToFrozenDir", "coldToFrozenScript", "remotePath", "maxDataSize",
]);
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

type Tab = "overview" | "fields" | "fieldsUsed" | "quality" | "lineage" | "relationships" | "annotations" | "raw";

export function EntityPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { catalog } = useCatalog();
  const entity = catalog.byId.get(id);

  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  useEffect(() => { if (entity) rememberViewed(entity.id); }, [entity]);

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
  // Shown in their own section (EmailRecipients).
  const OWN_SECTION = new Set(["alertRecipients", "defaultRecipients", "sender", "pivot", "storage", "indexTime", "appliesTo"]);
  const shownInStorage = entity.type === "index" && !!props.storage;
  const rest = Object.entries(props).filter(
    ([k]) => !(k in CODE) && !OWN_SECTION.has(k) && !(isDetection(entity) && DETECTION_KEYS.has(k)) && !(shownInStorage && STORAGE_KEYS.has(k)),
  );
  const groups = relationGroups(catalog, entity.id);
  const relCount = groups.reduce((n, g) => n + g.entities.length, 0);
  const fields = fieldsTable(catalog, entity);
  const ownerUser = entity.owner ? catalog.byId.get(`${entity.instance}:user:${entity.owner}`) : undefined;
  const instance = catalog.bundle.instances.find((i) => i.id === entity.instance);
  const a = entity.annotations;

  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ...(fields ? [["fields", entity.type === "dataModel" ? `Datasets (${fields.rows.length})` : `Fields (${fields.rows.length})`] as [Tab, string]] : []),
    ...(entity.quality
      ? [["quality", entity.quality.failed ? `Data quality ✕ ${entity.quality.failed}` : "Data quality"] as [Tab, string]]
      : []),
    ...(entity.lineage?.fields && entity.type !== "field"
      ? [["fieldsUsed", `Fields used (${entity.lineage.fields.used.length})`] as [Tab, string]]
      : []),
    ...(hasLineage(catalog, entity.id) || entity.lineage
      ? [["lineage", entity.lineage?.unresolved?.length ? "Lineage ⚠" : "Lineage"] as [Tab, string]]
      : []),
    ["relationships", `Relationships (${relCount})`],
    ["annotations", "Annotations"],
    ["raw", "Raw"],
  ];
  const relView = params.get("view") === "list" ? "list" : "graph";
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
        {from && <p className="small back-link"><Link to={from}>← Back to results</Link></p>}
        <TypeBadge entity={entity} />
        {catalog.bundle.instances.length > 1 && (
          <Link to={searchPath({ instance: entity.instance })} className="instance-badge" title="The stack (instance) this object is on">
            {instance?.name ?? entity.instance}
          </Link>
        )}
        <h1 className={`entity-title${entity.type === "adhocSearch" ? " spl-title" : ""}`}>{entity.displayName ?? entity.name}</h1>
        {entity.displayName && entity.displayName !== entity.name && (
          <div className="muted"><code>{entity.name}</code></div>
        )}
        <p className="fqn">
          <code>{entity.id}</code>{" "}
          <CopyButton text={entity.id} label="Copy id" className="link-btn small" />{" "}
          <CopyButton text={window.location.href} label="Copy link" className="link-btn small" />
        </p>
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

      <RiskBanner catalog={catalog} entity={entity} />

      <div className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`tab${tab === t ? " tab-active" : ""}`} onClick={() => selectTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <PropContext.Provider value={{ catalog, entity }}>
        <SectionNav deps={entity.id} />
        <div className="stack" data-sections="">
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

          <FieldPanel catalog={catalog} entity={entity} />

          <PropertiesPanel catalog={catalog} entity={entity} />

          <GovernancePanel catalog={catalog} entity={entity} />

          <UsagePanel entity={entity} />
          {entity.type === "index" && <StoragePanel entity={entity} />}
          {(entity.type === "sourcetype" || entity.type === "transform") && <IndexTimePanel entity={entity} />}

          <BlastRadius catalog={catalog} entity={entity} />

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

          {(() => {
            const ch = catalog.bundle.changes;
            const rows = (ch?.details as Record<string, DiffRow[]> | undefined)?.[entity.id];
            return rows?.length ? (
              <section>
                <h2>Changed in the last build</h2>
                <p className="muted small">Since the build of {new Date(ch!.previousGeneratedAt).toLocaleString()}. <Link to="/changes">All changes</Link></p>
                <DiffTable rows={rows} />
              </section>
            ) : null;
          })()}

          {code.map(([k, v]) => (
            <section key={k}>
              <h2>{CODE[k]}</h2>
              {SPL_KEYS.has(k) && (k !== "definition" || entity.type === "macro" || entity.type === "eventtype")
                ? <SplCode text={v as string} catalog={catalog} entity={entity} />
                : <pre className="code">{v as string}</pre>}
            </section>
          ))}
          <CommandList catalog={catalog} entity={entity} />

          {!!props.pivot && <PivotSource entity={entity} pivot={props.pivot as { dataModel: string; dataset: string }} />}
          <EmailRecipients recipients={props.alertRecipients} />
          {/* The email alert action's defaults, for searches that set none. */}
          {!!(props.defaultRecipients || props.sender) && (
            <EmailRecipients
              title="Default email recipients"
              recipients={{ ...(props.defaultRecipients as object), from: props.sender }}
            />
          )}
          {rest.length > 0 && (
            <section>
              <h2>Properties</h2>
              <dl className="facts">
                {rest.map(([k, v]) => (
                  <div key={k} className="fact-pair"><dt title={k}>{propLabel(k)}</dt><dd><PropValue value={v} name={k} /></dd></div>
                ))}
              </dl>
            </section>
          )}

          {observed !== undefined && (
            <section>
              <h2>Observed</h2>
              <p className="muted small">Measured {new Date(measuredAt(catalog.bundle)).toLocaleString()}; ages are counted from then.</p>
              <PropValue value={Object.fromEntries(Object.entries((observed ?? {}) as Record<string, unknown>)
            .filter(([k]) => k !== "dailyEvents"))} />
            </section>
          )}
        </div>
        </PropContext.Provider>
      )}

      {tab === "fields" && (entity.type === "sourcetype" ? <SchemaTab catalog={catalog} entity={entity} />
        : (entity.type === "lookup" || entity.type === "kvCollection") && lookupColumns(entity).length ? <LookupFieldsTab catalog={catalog} entity={entity} />
        : entity.type === "dataModel" ? <DataModelTab catalog={catalog} entity={entity} />
        : fields && <FieldsTab table={fields} />)}

      {tab === "fieldsUsed" && <SearchFieldsTab catalog={catalog} entity={entity} />}

      {tab === "quality" && <QualityTab entity={entity} />}

      {tab === "lineage" && <LineageTab catalog={catalog} entity={entity} />}

      {tab === "relationships" && (
        groups.length === 0 ? (
          <p className="muted">No relationships found.</p>
        ) : (
          <div className="stack">
            <div className="view-switch" role="group" aria-label="Relationships view">
              {(["graph", "list"] as const).map((v) => (
                <button key={v} type="button" className={`btn btn-small${relView === v ? " btn-selected" : ""}`} aria-pressed={relView === v}
                  onClick={() => { const next = new URLSearchParams(params); next.set("view", v); setParams(next, { replace: true }); }}>
                  {v === "graph" ? "Graph" : "List"}
                </button>
              ))}
            </div>
            {relView === "graph" ? (
              <RelationGraph catalog={catalog} entity={entity} groups={groups}
                onShowList={() => { const next = new URLSearchParams(params); next.set("view", "list"); setParams(next, { replace: true }); }} />
            ) : (
              <div className="rel-grid">
                {groups.map((g) => <Group key={`${g.direction}:${g.edgeType}`} group={g} />)}
              </div>
            )}
          </div>
        )
      )}

      {tab === "annotations" && <AnnotationsTab entity={entity} source={catalog.bundle.annotationSource} />}

      {tab === "raw" && <pre className="code raw">{JSON.stringify(entity, null, 2)}</pre>}
    </div>
  );
}

/** Who an email alert action writes to. A $token$ is filled in when the alert fires. */
/** A report made in Pivot: the data model and dataset it pivots on. */
function PivotSource({ entity, pivot }: { entity: Entity; pivot: { dataModel: string; dataset: string } }) {
  const { catalog } = useCatalog();
  const model = catalog.findOne(entity.instance, "dataModel", pivot.dataModel);
  return (
    <section>
      <h2>Pivot</h2>
      <p>
        Built in Pivot on data model{" "}
        {model ? <Link to={`/entity/${encodeURIComponent(model.id)}`}>{model.displayName ?? model.name}</Link> : <code>{pivot.dataModel}</code>}
        , dataset <code>{pivot.dataset}</code>.
      </p>
    </section>
  );
}

function EmailRecipients({ recipients, title = "Email recipients" }: { recipients: unknown; title?: string }) {
  if (!recipients || typeof recipients !== "object") return null;
  const r = recipients as { to?: string[]; cc?: string[]; bcc?: string[]; from?: string };
  const rows: [string, string[]][] = [
    ["To", r.to ?? []],
    ["Cc", r.cc ?? []],
    ["Bcc", r.bcc ?? []],
    ["From", r.from ? [r.from] : []],
  ];
  const shown = rows.filter(([, v]) => v.length);
  if (!shown.length) return null;
  const isToken = (a: string) => a.startsWith("$") && a.endsWith("$");
  return (
    <section>
      <h2>{title}</h2>
      <dl className="facts">
        {shown.map(([k, v]) => (
          <div key={k} className="fact-pair">
            <dt>{k}</dt>
            <dd>
              {v.map((a, i) => (
                <span key={a}>
                  {i > 0 && ", "}
                  {isToken(a) ? (
                    <span title="Filled in when the alert fires">
                      <code>{a}</code> <span className="muted small">(from the results)</span>
                    </span>
                  ) : !a.includes("@") ? (
                    <span title="Splunk adds the server's host name">{a}</span>
                  ) : (
                    <a href={`#/search?q=${encodeURIComponent(a)}`} title="Other alerts that email this address">{a}</a>
                  )}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
