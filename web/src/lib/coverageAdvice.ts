/**
 * What would let a detection that cannot fire work again: enable it, define what it
 * refers to, or bring in the data its data models expect (with the CIM tags that
 * route events into them, and any sourcetypes already in the catalog that carry them).
 */
import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";
import type { DetectionStatus } from "./coverage";

/** CIM data models and the tags their root datasets select (CIM 5.x). */
export const CIM_TAGS: Record<string, string[]> = {
  Alerts: ["alert"],
  Authentication: ["authentication"],
  Certificates: ["certificate"],
  Change: ["change"],
  Data_Access: ["data", "access"],
  DLP: ["dlp", "incident"],
  Email: ["email"],
  Endpoint: ["process", "report", "service", "endpoint", "filesystem", "registry"],
  Intrusion_Detection: ["ids", "attack"],
  Inventory: ["inventory"],
  Malware: ["malware", "attack"],
  Network_Resolution: ["network", "resolution", "dns"],
  Network_Sessions: ["network", "session"],
  Network_Traffic: ["network", "communicate"],
  Performance: ["performance"],
  Updates: ["update", "status"],
  Vulnerabilities: ["vulnerability", "report"],
  Web: ["web"],
};

const KIND_WORDS: Record<string, string> = {
  macro: "Define the macro", lookup: "Create the lookup", index: "Create the index", savedSearch: "Create the saved search",
  eventtype: "Create the event type", dataModel: "Install the data model", tag: "Add the tag",
};

/** Sourcetypes in the catalog that look like they carry a tag (tag objects or eventtypes tagged so). */
function sourcetypesWithTag(catalog: Catalog, instance: string, tag: string): string[] {
  const out = new Set<string>();
  for (const t of catalog.entities) {
    if (t.instance !== instance || t.type !== "tag" || t.name !== tag) continue;
    for (const e of catalog.edgesFrom(t.id).concat(catalog.edgesTo(t.id))) {
      const other = catalog.byId.get(e.from === t.id ? e.to : e.from);
      if (other?.type === "sourcetype") out.add(other.name);
      if (other?.type === "eventtype") {
        for (const x of catalog.edgesFrom(other.id)) {
          const st = catalog.byId.get(x.to);
          if (st?.type === "sourcetype") out.add(st.name);
        }
      }
    }
  }
  return [...out].sort();
}

export function howToFix(catalog: Catalog, d: DetectionStatus): string[] {
  const e: Entity = d.entity;
  if (d.state === "disabled") return [`Enable it in Splunk${e.app ? ` (app ${e.app})` : ""}, if it is still wanted.`];
  if (d.state === "broken") {
    return (e.lineage?.unresolved ?? []).map((ref) => {
      const [kind, ...rest] = ref.split(":");
      const name = rest.join(":");
      const tags = kind === "dataModel" ? CIM_TAGS[name] : undefined;
      const base = `${KIND_WORDS[kind] ?? `Create the ${kind}`} ${name}, or share it with the detection's app${e.app ? ` (${e.app})` : ""}`;
      return tags ? `${base}: it is part of the Splunk Common Information Model add-on (Splunk_SA_CIM); its events carry the tags ${tags.join(", ")}.` : `${base}.`;
    });
  }
  if (d.state === "noData") {
    if (!d.dataModels.length) return ["Nothing upstream has events: check the indexes and sourcetypes it searches are receiving data (Lineage tab)."];
    return d.dataModels.map((m) => {
      const tags = CIM_TAGS[m];
      if (!tags) return `Bring in data that feeds the ${m} data model.`;
      const have = [...new Set(tags.flatMap((t) => sourcetypesWithTag(catalog, e.instance, t)))];
      return `Bring in data for the ${m} data model: events tagged ${tags.join(" and ")} (usually from a CIM-compliant add-on).` +
        (have.length ? ` Sourcetypes here already tagged so: ${have.join(", ")}; check they receive events.` : "");
    });
  }
  return [];
}
