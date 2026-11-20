/**
 * What each part of a build did (bundle.ingestionReport), in words: the part's name as
 * the Build page shows it, read / skipped / failed, objects found, time taken, why.
 */
import type { CatalogBundle } from "../generated/catalog";
import { PRODUCT_LABELS } from "./labels";
import { PART_GROUPS } from "./splunkBuild";
import { propLabel } from "./propertyFormat";

type Report = NonNullable<CatalogBundle["ingestionReport"]>[number];

export interface PartRow {
  connector: string;
  area: string;
  part: string;
  status: "ok" | "partial" | "skipped" | "failed";
  objects?: number;
  seconds?: number;
  reason?: string;
  instance?: string;
}

const PART_LABEL = new Map(PART_GROUPS.flatMap((g) => g.parts.map((p) => [p.id, p.label] as const)));
const PROCESSING: Record<string, string> = {
  lineage: "SPL lineage",
  resolver: "Resolving references",
  health: "Health and usage",
  merge: "Merging instances",
  governance: "Governance (classifications, access)",
  annotations: "Annotations",
};

export const STATUS_WORDS: Record<PartRow["status"], string> = {
  ok: "Read",
  partial: "Partly read",
  skipped: "Skipped",
  failed: "Failed",
};

export function partRows(reports: Report[]): PartRow[] {
  return reports.map((r) => {
    const [prefix, ...rest] = r.connector.split(".");
    const sub = rest.join(".");
    let area: string;
    let part: string;
    if (prefix === "splunk") {
      area = "Splunk";
      part = PART_LABEL.get(sub) ?? propLabel(sub);
    } else if (!sub) {
      area = "Processing";
      part = PROCESSING[prefix] ?? propLabel(prefix);
    } else {
      area = PRODUCT_LABELS[prefix as keyof typeof PRODUCT_LABELS] ?? propLabel(prefix);
      part = propLabel(sub);
    }
    const counts = r.counts ?? {};
    const objects = counts.entities ?? (Object.keys(counts).length ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined);
    return {
      connector: r.connector,
      area,
      part,
      status: r.status,
      objects,
      seconds: (r as { durationSecs?: number }).durationSecs,
      reason: r.message,
      instance: r.instance,
    };
  });
}

/** "54 parts read, 3 skipped, 1 failed". */
export function coverageSummary(rows: PartRow[]): string {
  const n = (s: PartRow["status"]) => rows.filter((r) => r.status === s).length;
  const parts = [`${n("ok")} read`];
  if (n("partial")) parts.push(`${n("partial")} partly read`);
  if (n("skipped")) parts.push(`${n("skipped")} skipped`);
  if (n("failed")) parts.push(`${n("failed")} failed`);
  return parts.join(", ");
}
