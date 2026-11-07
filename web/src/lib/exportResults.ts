import type { Entity } from "../generated/catalog";
import { effectiveDescription } from "./annotate";
import { effectiveClassifications } from "./governance";
import { PRODUCT_LABELS, typeLabel } from "./labels";
import type { Risk } from "./risk";
import { entityPath } from "./routes";
import { label, propertyValues, valueStrings, type PropertyDef } from "./structured";

export interface ExportContext {
  instanceNames: Record<string, string>;
  defs: PropertyDef[];
  risk: Map<string, Risk>;
  /** Page URL up to the hash, e.g. https://example.github.io/delvecat/ */
  baseUrl: string;
}

const list = (xs?: string[]) => (xs ?? []).join("; ");

/** Search results as CSV rows (header first): one row per object, one column per structured property. */
export function resultRows(entities: Entity[], ctx: ExportContext): (string | number | undefined)[][] {
  const header = [
    "id", "type", "name", "display name", "product", "instance", "app", "Splunk owner", "sharing", "status",
    "description", "domain", "data products", "owners", "tags", "classifications", "glossary terms",
    "health", "health findings", "at risk", "at risk from", "unused", "last used", "updated in Splunk",
    "Splunk link", "catalog link",
    ...ctx.defs.map((d) => label(d)),
  ];
  const rows = entities.map((e) => {
    const a = e.annotations ?? {};
    const risk = ctx.risk.get(e.id);
    const props = propertyValues(e);
    return [
      e.id, typeLabel(e.type), e.name, e.displayName, PRODUCT_LABELS[e.product] ?? e.product,
      ctx.instanceNames[e.instance] ?? e.instance, e.app, e.owner, e.sharing, e.disabled ? "disabled" : "enabled",
      effectiveDescription(e), a.domain, list(a.dataProducts), list(a.owners), list(a.tags),
      list([...new Set(effectiveClassifications(e).map((c) => c.name))]), list(a.glossaryTerms),
      e.health?.status, list(e.health?.checks.filter((c) => c.status !== "ok").map((c) => c.message)),
      risk?.severity, list(risk?.causes.map((c) => c.root.id)),
      e.usage?.unused === undefined ? undefined : e.usage.unused ? "yes" : "no", e.usage?.lastUsed, e.updatedAt,
      e.sourceUrl, `${ctx.baseUrl}#${entityPath(e.id)}`,
      ...ctx.defs.map((d) => (props[d.id] === undefined ? undefined : valueStrings(props[d.id]).join("; "))),
    ];
  });
  return [header, ...rows];
}

/** "delvecat-firewall-2026-11-07.csv"; "delvecat-catalog-…" with no query. */
export function exportFileName(query: string, now = new Date()): string {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "catalog";
  return `delvecat-${slug}-${now.toISOString().slice(0, 10)}.csv`;
}
