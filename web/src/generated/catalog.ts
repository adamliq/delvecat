/* Generated from schemas/catalog.schema.json by npm run gen:types. Do not edit. */

export type EntityType =
  | "instance"
  | "app"
  | "user"
  | "role"
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
  | "macro"
  | "eventtype"
  | "tag"
  | "fieldAlias"
  | "calculatedField"
  | "fieldExtraction"
  | "transform"
  | "workflowAction"
  | "dashboard"
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
  | "externalTable";
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
 * Direction conventions: app contains object; sourcetype/host/source/input feeds index; role grantsAccess index; user memberOf role; role inherits importedRole; object uses dependency (transform, lookup file, KV collection, field alias...).
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
  | "inherits";

/**
 * A DelveCat catalog bundle: a point-in-time, read-only snapshot of Splunk metadata.
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
   * When present, entities and edges live in these files (paths relative to this manifest) and the entities/edges arrays here are empty.
   */
  shards?: Shard[];
}
export interface Instance {
  id: string;
  name: string;
  kind: "splunkEnterprise" | "splunkCloud" | "soar" | "uba" | "deploymentServer";
  version?: string;
  webUrl?: string;
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
  tags?: string[];
  owners?: string[];
  classifications?: string[];
  glossaryTerms?: string[];
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
   * When DelveCat first saw this entity.
   */
  firstSeenAt?: string;
  /**
   * Hash of the entity's extracted content, used to detect changes.
   */
  contentHash?: string;
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
}
export interface ChangeSummary {
  previousGeneratedAt: string;
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
