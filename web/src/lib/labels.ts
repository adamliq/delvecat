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
  kvCollection: "KV Store Collection",
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
