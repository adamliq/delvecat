import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { dataModelColumns, dataModelsWithField, datasetFields, datasetSearches, datasetsOf } from "./dataModels";
import { EntitySearch, matchSnippet } from "./search";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

const assets = ent("dataModel", "Assets", {
  properties: {
    datasets: [
      { name: "Hosts", parent: "BaseEvent", constraint: "index=assets", fields: ["_time", "ip", "mac", "owner"],
        fieldInfo: [{ name: "ip", type: "string", required: true }, { name: "mac", type: "string", multivalue: true },
          { name: "owner", type: "string", calculation: "lookup" }],
        calculations: [{ type: "lookup", lookup: "asset_owners", lookupInputs: { ip: "ip" }, outputs: ["owner"] }] },
      { name: "Servers", parent: "Hosts", path: "Hosts.Servers", constraint: "role=server", fields: ["_time", "ip", "owner", "rack"],
        fieldInfo: [{ name: "rack", type: "number" }] },
    ],
  },
});
const viaTstats = ent("savedSearch", "servers by rack", { lineage: { dataModelDatasets: ["Assets.Hosts.Servers"] } });
const viaDatamodel = ent("savedSearch", "servers", { lineage: { dataModelDatasets: ["Assets.Servers"] } });
const viaRoot = ent("correlationSearch", "hosts", { lineage: { dataModelDatasets: ["Assets.Hosts"] } });
const elsewhere = ent("savedSearch", "other", { instance: "j", lineage: { dataModelDatasets: ["Assets.Hosts"] } });
const field = ent("field", "fw/owner", { displayName: "owner", properties: { sourcetype: "fw", field: "owner" } });

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }, { id: "j", name: "j", kind: "splunkEnterprise" }],
  entities: [assets, viaTstats, viaDatamodel, viaRoot, elsewhere, field],
  edges: [],
};
const c = new Catalog(bundle);
const [hosts, servers] = datasetsOf(assets);

describe("data models", () => {
  it("gives each dataset field its type and where it is defined", () => {
    const f = Object.fromEntries(datasetFields(assets, servers).map((x) => [x.name, x]));
    expect(f.rack).toMatchObject({ type: "number", from: "Servers", inherited: false });
    expect(f.ip).toMatchObject({ type: "string", required: true, from: "Hosts", inherited: true });
    expect(f.owner).toMatchObject({ calculation: "lookup", from: "Hosts" });
    expect(f._time).toMatchObject({ from: "BaseEvent", inherited: true });
    expect(datasetFields(assets, hosts).find((x) => x.name === "mac")).toMatchObject({ multivalue: true, inherited: false });
  });

  it("finds the searches naming a dataset by path or by name, on the same instance", () => {
    expect(datasetSearches(c, assets, servers).map((e) => e.name).sort()).toEqual(["servers", "servers by rack"]);
    expect(datasetSearches(c, assets, hosts).map((e) => e.name)).toEqual(["hosts"]);
  });

  it("lists field names, finds models by field, and makes them searchable", () => {
    expect(dataModelColumns(assets)).toEqual(["ip", "mac", "owner", "rack"]);
    expect(dataModelsWithField(c, "RACK").map((r) => [r.model.name, r.datasets])).toEqual([["Assets", ["Servers"]]]);
    expect(dataModelsWithField(c, "_time")).toEqual([]);
    const s = new EntitySearch(bundle.entities, { field: (e) => (e.type === "dataModel" ? dataModelColumns(e) : []) });
    const { results, matches } = s.query("rack");
    expect(results.map((e) => e.name)).toContain("Assets");
    expect(matchSnippet(assets, matches?.get(assets.id))).toEqual({ where: "field", text: "rack" });
    expect(s.query("", { field: ["mac"] }).results.map((e) => e.name)).toEqual(["Assets"]);
  });
});
