import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { commandInventory, customCommand, customRisk } from "./commands";
import { EntitySearch, FACETS } from "./search";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const purge = ent("savedSearch", "purge", { lineage: { commands: ["delete"] } });
const top = ent("savedSearch", "top", { lineage: { commands: ["stats", "top"] }, disabled: true });
const enrich = ent("savedSearch", "enrich", { lineage: { commands: ["stats", "whois"] } });
const whois = ent("searchCommand", "whois", { app: "TA-whois", properties: { passAuth: true } });
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [purge, top, enrich, whois],
  edges: [],
};
const c = new Catalog(bundle);

describe("commands", () => {
  it("lists every command with how many searches run it and why it is risky", () => {
    const rows = Object.fromEntries(commandInventory(c).map((r) => [r.name, r]));
    expect(rows.stats).toMatchObject({ searches: 2, enabled: 1, custom: undefined, risk: undefined });
    expect(rows.delete.risk).toContain("deletes events");
    expect(rows.whois.custom?.id).toBe(whois.id);
    expect(rows.whois.risk).toBe("runs with the user's session");
    expect(commandInventory(c)[0].name).toBe("stats"); // most used first
  });

  it("finds a custom command and its risk", () => {
    expect(customCommand(c, enrich, "whois")).toBe(whois);
    expect(customRisk(customCommand(c, enrich, "stats"))).toBeUndefined();
  });

  it("filters searches by the commands they run", () => {
    const s = new EntitySearch(bundle.entities, { command: FACETS.command });
    expect(s.query("", { command: ["stats"] }).results.map((e) => e.name).sort()).toEqual(["enrich", "top"]);
  });
});

describe("commands on several stacks", () => {
  it("takes the custom command from each search's own stack", () => {
    const a = ent("savedSearch", "a", { lineage: { commands: ["whois"] } });
    const b = { ...ent("savedSearch", "b", { lineage: { commands: ["whois"] } }), id: "j:savedSearch:b", instance: "j" };
    const risky = { ...ent("searchCommand", "whois", { app: "TA-other", properties: { risky: true } }), id: "j:searchCommand:whois", instance: "j" };
    const cat = new Catalog({ ...bundle, instances: [...bundle.instances, { id: "j", name: "j", kind: "splunkEnterprise" }], entities: [a, b, whois, risky] });
    const row = commandInventory(cat).find((r) => r.name === "whois")!;
    expect([...row.stacks].sort()).toEqual(["i", "j"]);
    expect(customCommand(cat, b, "whois")).toBe(risky);
    expect(customCommand(cat, a, "whois")).toBe(whois);
  });
});
