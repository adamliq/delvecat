import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import { effectiveClassifications } from "./governance";
import { healthStatus } from "./health";
import { riskMap } from "./risk";

export type BadgeKind = "critical" | "warning" | "risk" | "sensitive";

export interface Badge {
  kind: BadgeKind;
  /** Short text shown on the badge: an icon, or a classification's top-level name. */
  text: string;
  /** Full explanation for the tooltip and screen readers. */
  title: string;
}

export const BADGE_LEGEND: { kind: BadgeKind; text: string; label: string }[] = [
  { kind: "critical", text: "✕", label: "Critical health finding" },
  { kind: "warning", text: "!", label: "Health warning" },
  { kind: "risk", text: "↯", label: "At risk from an upstream problem" },
  { kind: "sensitive", text: "PII", label: "Holds sensitive data (classification)" },
];

/** Health, risk and sensitivity markers for an object, most severe first. */
export function badges(catalog: Catalog, e: Entity): Badge[] {
  const out: Badge[] = [];
  const status = healthStatus(e);
  if (status !== "ok") {
    const findings = (e.health?.checks ?? []).filter((c) => c.status !== "ok").map((c) => c.message);
    out.push({ kind: status, text: status === "critical" ? "✕" : "!", title: `${status === "critical" ? "Critical" : "Warning"}: ${findings.join("; ")}` });
  }
  const risk = riskMap(catalog).get(e.id);
  if (risk) {
    const causes = risk.causes.map((c) => c.root.displayName ?? c.root.name);
    out.push({ kind: "risk", text: "↯", title: `At risk (${risk.severity}) from ${causes.join(", ")}` });
  }
  const sensitive = effectiveClassifications(e).filter((c) => c.sensitive);
  if (sensitive.length) {
    const roots = [...new Set(sensitive.map((c) => c.name.split(".")[0]))];
    const detail = sensitive.map((c) => (c.columns?.length ? `${c.name} in ${c.columns.join(", ")}` : c.name));
    out.push({ kind: "sensitive", text: roots.join("+"), title: `Sensitive: ${detail.join("; ")}` });
  }
  return out;
}
