/* Generated from schemas/catalog.schema.json by npm run gen:types. Do not edit. */

export type EntityType =
  | "instance"
  | "app"
  | "user"
  | "role"
  | "authGroup"
  | "authToken"
  | "index"
  | "sourcetype"
  | "source"
  | "host"
  | "field"
  | "dataModel"
  | "lookup"
  | "automaticLookup"
  | "kvCollection"
  | "savedSearch"
  | "adhocSearch"
  | "macro"
  | "searchCommand"
  | "eventtype"
  | "tag"
  | "fieldAlias"
  | "calculatedField"
  | "fieldExtraction"
  | "transform"
  | "workflowAction"
  | "dashboard"
  | "scheduledView"
  | "input"
  | "forwarder"
  | "correlationSearch"
  | "findingType"
  | "riskRule"
  | "threatIntelSource"
  | "assetIdentitySource"
  | "adaptiveResponseAction"
  | "analyticStory"
  | "responseTemplate"
  | "soarPlaybook"
  | "soarCustomFunction"
  | "soarApp"
  | "soarAsset"
  | "soarLabel"
  | "soarWorkbook"
  | "uebaDataSource"
  | "uebaModel"
  | "uebaAnomalyType"
  | "uebaThreatRule"
  | "uebaOutputConnector"
  | "ariSource"
  | "ariAssetType"
  | "ariMetric"
  | "ariExposure"
  | "streamForwarder"
  | "streamGroup"
  | "streamDefinition"
  | "serverClass"
  | "deploymentApp"
  | "deploymentClient"
  | "dbConnection"
  | "dbIdentity"
  | "dbInput"
  | "dbOutput"
  | "dbLookup"
  | "externalTable"
  | "federatedProvider"
  | "federatedIndex"
  | "spl2Connection"
  | "spl2Module"
  | "spl2Dataset"
  | "esReviewStatus"
  | "esSuppression"
  | "esAggregationRule"
  | "esAutomationRule"
  | "esQueue"
  | "dmCatalogObject"
  | "addOnAccount"
  | "outputGroup"
  | "accelerationSummary"
  | "fieldFilter"
  | "fieldDefinition"
  | "navMenu"
  | "timeRange"
  | "panel"
  | "visualization"
  | "multikvTable"
  | "segmenter";
/**
 * The Splunk product an entity belongs to.
 */
export type Product =
  | "splunk"
  | "enterpriseSecurity"
  | "soar"
  | "ueba"
  | "assetRiskIntelligence"
  | "stream"
  | "deploymentServer"
  | "dbConnect";
export type Sharing = "user" | "app" | "global" | "system";
/**
 * Direction conventions: app contains object; sourcetype/host/source/input feeds index; role grantsAccess index; user memberOf role; role inherits importedRole; object uses dependency (transform, lookup file, KV collection, field alias...); search (or field alias, calculated field, automatic lookup) readsField field; field extraction, alias, calculated field or automatic lookup definesField field.
 */
export type EdgeType =
  | "reads"
  | "writes"
  | "contains"
  | "uses"
  | "feeds"
  | "deploys"
  | "triggers"
  | "accelerates"
  | "mapsTo"
  | "grantsAccess"
  | "memberOf"
  | "inherits"
  | "readsField"
  | "definesField";

/**
 * A Licoryx Delvecat catalog bundle: a point-in-time, read-only snapshot of Splunk metadata.
 */
export interface CatalogBundle {
  schemaVersion: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
  };
  instances: Instance[];
  entities: Entity[];
  edges: Edge[];
  ingestionReport?: ConnectorReport[];
  changes?: ChangeSummary;
  /**
   * Health counts of this and earlier builds (oldest first), for a trend. Derived.
   */
  healthHistory?: {
    at: string;
    /**
     * Objects whose worst finding is critical.
     */
    critical: number;
    /**
     * Objects whose worst finding is a warning.
     */
    warning: number;
    /**
     * Findings (checks that are not OK).
     */
    findings?: number;
    unused?: number;
    /**
     * Custom objects of documented types (as on the Insights page).
     */
    documented?: number;
    described?: number;
    owned?: number;
    inDomain?: number;
  }[];
  /**
   * Findings the previous build had and this one does not: fixed, or the object was removed or disabled. Derived.
   */
  resolvedFindings?: {
    id: string;
    type: string;
    name: string;
    app?: string;
    check: string;
    status: "warning" | "critical";
    message: string;
    since?: string;
    how?: "fixed" | "removed" | "disabled";
  }[];
  /**
   * When present, entities and edges live in these files (paths relative to this manifest) and the entities/edges arrays here are empty.
   */
  shards?: Shard[];
  glossary?: GlossaryTerm[];
  annotationSource?: AnnotationSource;
  /**
   * Classification taxonomy from annotations.
   */
  classifications?: Classification[];
  /**
   * Present when the bundle was redacted for publishing.
   */
  redaction?: {
    profile?: string;
    stablePseudonyms?: boolean;
    counts?: {
      [k: string]: number;
    };
    [k: string]: unknown;
  };
  references?: OpenReference[];
  /**
   * Bundles combined by `delvecat-ingest merge`.
   */
  mergedFrom?: {
    instances: string[];
    generatedAt: string;
    source?: string;
  }[];
  domains?: Domain[];
  dataProducts?: DataProduct[];
  structuredProperties?: StructuredProperty[];
}
export interface Instance {
  id: string;
  name: string;
  kind: "splunkEnterprise" | "splunkCloud" | "soar" | "uba" | "deploymentServer";
  version?: string;
  webUrl?: string;
  /**
   * Set when this instance came into the catalog by Import (from a file or another stack): a build on this stack keeps it.
   */
  imported?: {
    from?: string;
    at?: string;
    by?: string;
  };
  roles?: string[];
  /**
   * Instance-level facts (e.g. server roles, Cloud IP allow-list counts). Never contains credentials.
   */
  properties?: {
    [k: string]: unknown;
  };
  product?: string;
}
export interface Entity {
  /**
   * Fully qualified name, unique within the bundle.
   */
  id: string;
  type: EntityType;
  name: string;
  displayName?: string;
  product: Product;
  instance: string;
  app?: string;
  owner?: string;
  sharing?: Sharing;
  disabled?: boolean;
  description?: string;
  updatedAt?: string;
  sourceUrl?: string;
  /**
   * Type-specific attributes. Never contains credentials.
   */
  properties?: {
    [k: string]: unknown;
  };
  /**
   * Increments when the entity's content changes between ingestion runs.
   */
  version?: number;
  /**
   * When Licoryx Delvecat first saw this entity.
   */
  firstSeenAt?: string;
  /**
   * Hash of the entity's extracted content, used to detect changes.
   */
  contentHash?: string;
  annotations?: Annotations;
  /**
   * Diagnostics from SPL analysis. Derived, so it never changes the catalog version.
   */
  lineage?: {
    /**
     * A search with no index constraint: it runs against the user's default indexes.
     */
    implicitIndex?: boolean;
    /**
     * Uses $tokens$, so some references are only known at run time.
     */
    dynamic?: boolean;
    /**
     * References to objects not found (or not visible) in the catalog, as type:name.
     */
    unresolved?: string[];
    warnings?: string[];
    fields?: FieldLineage;
    /**
     * Data model datasets the search names, as Model.Dataset or Model.Root.Child (from tstats nodename=).
     */
    dataModelDatasets?: string[];
    /**
     * Analysed from Splunk's own parse of the search (search/parser, macros expanded), because Licoryx Delvecat's analyser could not follow it.
     */
    parsedBySplunk?: boolean;
    /**
     * Search commands the search runs after a pipe (built-in and custom), by name.
     */
    commands?: string[];
  };
  /**
   * Data quality check results (derived; never changes the catalog version).
   */
  quality?: {
    passed: number;
    failed: number;
    tests: {
      test: string;
      field?: string;
      expectation: string;
      result: string;
      status: "pass" | "fail" | "unknown";
      /**
       * default, or the annotation file:line that defined it
       */
      source: string;
      why?: string;
    }[];
  };
  /**
   * How people and the scheduler use the object, from _audit and _internal. Derived; never changes the catalog version.
   */
  usage?: {
    runs?: number;
    users?: number;
    views?: number;
    viewers?: number;
    searches?: number;
    adhocSearches?: number;
    panelSearchRuns?: number;
    /**
     * Times the alert or detection triggered in alertWindow (not runs).
     */
    alertFires?: number;
    /**
     * Triggers suppressed by throttling in alertWindow.
     */
    alertsSuppressed?: number;
    lastFired?: string;
    /**
     * Splunk relative time the alert counts cover, e.g. -30d.
     */
    alertWindow?: string;
    /**
     * Times the alert fired per day: counts from start, one per day.
     */
    alertDaily?: {
      start: string;
      counts: number[];
    };
    lastUsed?: string;
    runtimeSecs?: number | null;
    /**
     * Scheduler outcomes in the health window; daily has runs and skipped-or-failed runs per day from start.
     */
    scheduler?: {
      daily?: {
        start: string;
        runs: number[];
        problems: number[];
      };
      [k: string]: unknown;
    };
    unused?: boolean;
    reason?: string;
    builtin?: boolean;
    [k: string]: unknown;
  };
  /**
   * Health checks evaluated when the bundle was built. Derived.
   */
  health?: {
    status: "ok" | "warning" | "critical";
    checks: {
      check: string;
      status: "ok" | "warning" | "critical";
      message: string;
      /**
       * When this finding was first seen: the build time of the earliest catalog that had it.
       */
      since?: string;
    }[];
  };
  /**
   * Splunk object permissions: roles that may read / write it ('*' = every role).
   */
  permissions?: {
    read?: string[];
    write?: string[];
  };
  /**
   * Derived governance facts: effective classifications with provenance, and who can reach sensitive data.
   */
  governance?: {
    [k: string]: unknown;
  };
}
/**
 * Human-curated metadata merged from annotations/*.yaml. Never comes from Splunk.
 */
export interface Annotations {
  description?: string;
  owners?: string[];
  tags?: string[];
  /**
   * e.g. PII.Email, Confidential, MITRE.T1078
   */
  classifications?: string[];
  qualityChecks?: {
    test: string;
    field?: string;
    min?: number;
    max?: number;
    source?: string;
  }[];
  /**
   * Classifications this object does not pass on to data derived from it; "*" stops all.
   */
  stopsClassifications?: string[];
  glossaryTerms?: string[];
  links?: Link[];
  /**
   * Annotation files (and entry numbers) that contributed, e.g. annotations/web.yaml#2
   */
  sources?: string[];
  /**
   * The entry that targets this entity by id (the one to edit), if any.
   */
  primarySource?: string;
  domain?: string;
  dataProducts?: string[];
  /**
   * Structured property values by id.
   */
  properties?: {
    [k: string]: string | number | boolean | unknown[];
  };
  /**
   * Required structured properties this object has no value for.
   */
  missingProperties?: string[];
}
export interface Link {
  title?: string;
  url: string;
}
/**
 * Field-level lineage from SPL: the fields a search reads from its data and how, and the source fields behind each output column (when the result shape is known).
 */
export interface FieldLineage {
  /**
   * What the fields belong to: events (sourcetype fields), a data model, a lookup, another search's results, a database, metrics or other.
   */
  source: "events" | "datamodel" | "lookup" | "search" | "database" | "metrics" | "other";
  used: {
    name: string;
    how: (
      | "filter"
      | "groupBy"
      | "aggregate"
      | "eval"
      | "rename"
      | "lookup"
      | "extract"
      | "enrich"
      | "join"
      | "dedup"
      | "sort"
      | "select"
      | "output"
    )[];
  }[];
  /**
   * Result columns, in order, each with the source fields it is computed from (empty for counts and constants).
   */
  outputs?: {
    name: string;
    from: string[];
    /**
     * The column does not reveal the values it is computed from (a count, a distinct count or a hash), so classifications of its source fields do not carry over.
     */
    masked?: boolean;
  }[];
}
export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  /**
   * How the edge was derived.
   */
  origin?: "config" | "spl" | "connector" | "annotation";
}
export interface ConnectorReport {
  connector: string;
  status: "ok" | "partial" | "skipped" | "failed";
  message?: string;
  counts?: {
    [k: string]: number;
  };
  /**
   * How long the part took, in seconds.
   */
  durationSecs?: number;
  /**
   * Health only: the thresholds the checks used (hours, days, seconds or ratios, as named).
   */
  thresholds?: {
    [k: string]: number;
  };
  /**
   * Instance the report is about (set when bundles are merged).
   */
  instance?: string;
}
export interface ChangeSummary {
  previousGeneratedAt: string;
  /**
   * For modified objects (up to 2000): what changed, key by key (properties.<name> one level down), values cut to 300 characters.
   */
  details?: {
    [k: string]: {
      key: string;
      before?: unknown;
      after?: unknown;
    }[];
  };
  added: string[];
  removed: RemovedEntity[];
  modified: string[];
}
export interface RemovedEntity {
  id: string;
  type: EntityType;
  name: string;
}
export interface Shard {
  path: string;
  kind: "entities" | "edges";
  entityType?: EntityType;
  count: number;
  sha256: string;
}
export interface GlossaryTerm {
  term: string;
  description?: string;
  synonyms?: string[];
  related?: string[];
  /**
   * Field names that carry this term in any sourcetype.
   */
  fields?: string[];
  owner?: string;
  source?: string;
}
/**
 * Where annotations live, so the web app can link to 'suggest an edit'.
 */
export interface AnnotationSource {
  repoUrl: string;
  branch: string;
  path: string;
}
export interface Classification {
  name: string;
  description?: string;
  sensitive?: boolean;
  propagate?: boolean;
  source?: string;
}
/**
 * A reference another instance may satisfy; re-resolved by `delvecat-ingest merge`.
 */
export interface OpenReference {
  known: string;
  edgeType: EdgeType;
  target: {
    type: EntityType;
    name: string;
    app?: string;
    pattern?: boolean;
  };
  knownIsFrom?: boolean;
  origin?: "config" | "spl" | "connector" | "annotation";
}
export interface Domain {
  name: string;
  description?: string;
  owners?: string[];
  parent?: string;
  links?: Link[];
  source?: string;
}
export interface DataProduct {
  name: string;
  domain?: string;
  description?: string;
  owners?: string[];
  links?: Link[];
  /**
   * Entity ids.
   */
  assets: string[];
  source?: string;
}
export interface StructuredProperty {
  id: string;
  displayName?: string;
  description?: string;
  type?: "string" | "number" | "boolean" | "date" | "url";
  allowedValues?: unknown[];
  cardinality?: "single" | "multiple";
  /**
   * Object types; omit for all.
   */
  appliesTo?: string[];
  required?: boolean;
  showInFilters?: boolean;
  showInSummary?: boolean;
  source?: string;
  requiredWhere?: {};
}
