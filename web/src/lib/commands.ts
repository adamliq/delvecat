import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

/** Built-in commands that delete data, run programs or a search per result, or send data
 * out of Splunk (as the ingestion's riskyCommand check names them). */
export const RISKY_COMMANDS: Record<string, string> = {
  delete: "deletes events (they can no longer be searched)",
  run: "runs a script on the search head",
  runshellscript: "runs a shell script on the search head",
  script: "runs a script on the search head",
  map: "runs a search for every result",
  sendemail: "sends results by email",
  sendalert: "runs an alert action",
  dump: "writes raw events to files on the search head",
  crawl: "crawls the file system",
  input: "adds inputs",
  outputcsv: "writes a CSV file on the search head",
};

export const commandsOf = (e: Entity): string[] => e.lineage?.commands ?? [];

/** The catalogued custom command of this name on the entity's instance, if any. */
export function customCommand(catalog: Catalog, e: Entity, name: string): Entity | undefined {
  return catalog.findOne(e.instance, "searchCommand", name);
}

/** Why a custom command is risky (commands.conf is_risky, or passauth), or undefined. */
export function customRisk(c: Entity | undefined): string | undefined {
  const p = (c?.properties ?? {}) as { risky?: boolean; passAuth?: boolean };
  return p.passAuth ? "runs with the user's session" : p.risky ? "marked risky in commands.conf" : undefined;
}

export interface CommandRow {
  name: string;
  custom?: Entity;
  risk?: string;
  searches: number;
  enabled: number;
  /** Stacks whose searches run it. */
  stacks: Set<string>;
}

const cache = new WeakMap<Catalog, CommandRow[]>();

/** Every command searches in the catalog run, with how many searches run it. */
export function commandInventory(catalog: Catalog): CommandRow[] {
  const hit = cache.get(catalog);
  if (hit) return hit;
  const rows = new Map<string, CommandRow>();
  for (const e of catalog.entities) {
    for (const name of commandsOf(e)) {
      // The custom command on the search's own stack (another stack may have a different one).
      const c = catalog.findOne(e.instance, "searchCommand", name);
      let r = rows.get(name);
      if (!r) {
        r = { name, custom: c, risk: RISKY_COMMANDS[name] ?? customRisk(c), searches: 0, enabled: 0, stacks: new Set() };
        rows.set(name, r);
      } else if (c && !r.custom) {
        r.custom = c;
        r.risk ??= customRisk(c);
      } else if (c && r.custom && r.custom.id !== c.id) {
        r.risk ??= customRisk(c);
      }
      r.stacks.add(e.instance);
      r.searches++;
      if (!e.disabled) r.enabled++;
    }
  }
  const out = [...rows.values()].sort((a, b) => b.searches - a.searches || a.name.localeCompare(b.name));
  cache.set(catalog, out);
  return out;
}
