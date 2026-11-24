import type { EntityType, Product } from "../generated/catalog";

export const PRODUCT_LABELS: Record<Product, string> = {
  splunk: "Splunk Platform",
  enterpriseSecurity: "Enterprise Security",
  soar: "SOAR",
  ueba: "UEBA",
  assetRiskIntelligence: "Asset & Risk Intelligence",
  stream: "Stream",
  deploymentServer: "Deployment Server",
  dbConnect: "DB Connect",
};

const SPECIAL: Partial<Record<EntityType, string>> = {
  authGroup: "Identity Group",
  authToken: "Authentication Token",
  scheduledView: "Scheduled View",
  federatedProvider: "Federated Provider",
  federatedIndex: "Federated Index",
  spl2Connection: "SPL2 Connection",
  spl2Module: "SPL2 Module",
  spl2Dataset: "SPL2 Dataset",
  esReviewStatus: "Review Status",
  esSuppression: "Suppression",
  esAggregationRule: "Finding Aggregation Rule",
  esAutomationRule: "Automation Rule",
  esQueue: "Queue",
  dmCatalogObject: "Data Management Catalog Object",
  addOnAccount: "Add-on Account",
  outputGroup: "Output Group",
  accelerationSummary: "Acceleration Summary",
  responseTemplate: "Response Plan",
  kvCollection: "KV Store Collection",
  correlationSearch: "Detection",
  adhocSearch: "Ad-hoc Search",
  fieldFilter: "Field Filter",
  fieldDefinition: "Field Definition",
  navMenu: "Navigation Menu",
  timeRange: "Time Range",
  panel: "Prebuilt Panel",
  multikvTable: "Multikv Table",
  adaptiveResponseAction: "Alert Action",
  threatIntelSource: "Threat Intel Source",
  assetIdentitySource: "Asset / Identity Source",
  automaticLookup: "Automatic Lookup",
  soarApp: "SOAR App",
  soarAsset: "SOAR Asset",
  soarPlaybook: "SOAR Playbook",
  soarCustomFunction: "SOAR Custom Function",
  soarLabel: "SOAR Label",
  soarWorkbook: "SOAR Workbook",
  uebaDataSource: "UEBA Data Source",
  uebaModel: "UEBA Model",
  uebaAnomalyType: "UEBA Anomaly Type",
  uebaThreatRule: "UEBA Threat Rule",
  uebaOutputConnector: "UEBA Output Connector",
  ariSource: "ARI Source",
  ariAssetType: "ARI Asset Type",
  ariMetric: "ARI Metric",
  ariExposure: "ARI Exposure",
  dbConnection: "DB Connection",
  dbIdentity: "DB Identity",
  dbInput: "DB Input",
  dbOutput: "DB Output",
  dbLookup: "DB Lookup",
};

/** "savedSearch" → "Saved Search" */
export function typeLabel(type: EntityType): string {
  return SPECIAL[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

export function pluralTypeLabel(type: EntityType): string {
  const label = typeLabel(type);
  if (/(x|ch|sh|s)$/.test(label)) return `${label}es`;
  if (/[^aeiou]y$/.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/** Areas object types fall into (the Browse page groups its type filter by them). */
export const TYPE_GROUPS: [string, string[]][] = [
  ["Data", ["index", "sourcetype", "source", "host", "field", "dataModel", "lookup", "automaticLookup", "kvCollection", "federatedIndex", "federatedProvider", "accelerationSummary"]],
  ["Inputs and forwarding", ["input", "forwarder", "outputGroup", "addOnAccount", "serverClass", "deploymentApp", "deploymentClient", "streamForwarder", "streamGroup", "streamDefinition"]],
  ["Searches, alerts and dashboards", ["savedSearch", "adhocSearch", "dashboard", "panel", "visualization", "navMenu", "timeRange", "scheduledView", "adaptiveResponseAction"]],
  ["Knowledge objects", ["macro", "eventtype", "tag", "fieldAlias", "calculatedField", "fieldExtraction", "transform", "workflowAction", "searchCommand", "fieldDefinition", "multikvTable", "segmenter"]],
  ["Platform and access", ["instance", "app", "user", "role", "authGroup", "authToken", "fieldFilter"]],
  ["Enterprise Security", ["correlationSearch", "findingType", "riskRule", "threatIntelSource", "assetIdentitySource", "analyticStory", "responseTemplate", "esReviewStatus", "esSuppression", "esAggregationRule", "esAutomationRule", "esQueue"]],
  ["SOAR", ["soarPlaybook", "soarCustomFunction", "soarApp", "soarAsset", "soarLabel", "soarWorkbook"]],
  ["UEBA and Asset & Risk Intelligence", ["uebaDataSource", "uebaModel", "uebaAnomalyType", "uebaThreatRule", "uebaOutputConnector", "ariSource", "ariAssetType", "ariMetric", "ariExposure"]],
  ["DB Connect", ["dbConnection", "dbIdentity", "dbInput", "dbOutput", "dbLookup", "externalTable"]],
  ["SPL2 and Data Management", ["spl2Module", "spl2Dataset", "spl2Connection", "dmCatalogObject"]],
];

const GROUP_OF = new Map(TYPE_GROUPS.flatMap(([g, types]) => types.map((t) => [t, g] as const)));

/** The area a type belongs to ("Other" for one not listed). */
export const typeGroup = (type: string): string => GROUP_OF.get(type) ?? "Other";
