import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { isLookupSchema, lookupColumns, lookupsWithField, schemaLookups } from "./lookups";
import { compareSchemas, fieldType, schemaFields, similarSchemas } from "./schema";
import { EntitySearch, matchSnippet } from "./search";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const E = (a: Entity, type: Edge["type"], b: Entity): Edge => ({ from: a.id, to: b.id, type });
const fld = (st: string, n: string) =>
  ent("field", `${st}/${n}`, { displayName: n, properties: { sourcetype: st, field: n, numeric: false } });

const fw = ent("sourcetype", "fw");
const fwF = [fld("fw", "src_ip"), fld("fw", "owner"), fld("fw", "action")];
const owners = ent("lookup", "a/asset_owners", { properties: { kind: "csv", filename: "asset_owners.csv", fields: ["ip", "owner", "dept"] } });
// The file behind it carries a copy of the definition's fields: not a schema of its own.
const ownersFile = ent("lookup", "a/asset_owners.csv", { properties: { kind: "file", fields: ["ip", "owner", "dept"], fieldsFrom: owners.id } });
const codes = ent("lookup", "a/web_status_codes.csv", { properties: { kind: "file", fields: ["status", "meaning"], fieldsFrom: "header" } });
const threats = ent("kvCollection", "a/threats", { properties: { fields: { ip: "string", score: "number" } } });
const empty = ent("lookup", "a/geo", { properties: { kind: "geo" } });

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [fw, ...fwF, owners, ownersFile, codes, threats, empty],
  edges: fwF.map((f) => E(fw, "contains", f)),
};
const c = new Catalog(bundle);

describe("lookup fields", () => {
  it("lists the fields of definitions, files and KV Store collections", () => {
    expect(lookupColumns(owners)).toEqual(["ip", "owner", "dept"]);
    expect(lookupColumns(threats)).toEqual(["ip", "score"]);
    expect(lookupColumns(empty)).toEqual([]);
    expect(lookupColumns(fw)).toEqual([]);
  });

  it("treats copies and lookups without fields as no schema of their own", () => {
    expect([owners, ownersFile, codes, threats, empty].map(isLookupSchema)).toEqual([true, false, true, true, false]);
    expect(schemaLookups(c).map((e) => e.name)).toEqual(["a/asset_owners", "a/threats", "a/web_status_codes.csv"]);
  });

  it("finds lookups by field name, case-insensitively", () => {
    expect(lookupsWithField(c, "IP").map((e) => e.name)).toEqual(["a/asset_owners", "a/threats"]);
    expect(lookupsWithField(c, "ip", "other")).toEqual([]);
  });

  it("gives lookups a schema: KV Store types, similar schemas and comparison", () => {
    expect(schemaFields(c, threats).map(fieldType)).toEqual(["string", "number"]);
    const sim = similarSchemas(c, fw);
    expect(sim.map((r) => r.entity.name)).toEqual(["a/asset_owners"]);
    expect(sim[0].shared).toEqual(["owner"]);
    const rows = compareSchemas(c, owners, fw);
    expect(rows.find((r) => r.name === "owner")?.status).toBe("same");
    expect(rows.find((r) => r.name === "dept")?.status).toBe("onlyA");
    expect(rows.find((r) => r.name === "owner")?.a?.id).toBe(owners.id); // links to the lookup
  });

  it("finds lookups by a field name in search, says which field, and filters by field", () => {
    const s = new EntitySearch(bundle.entities, { field: (e) => lookupColumns(e) });
    const { results, matches } = s.query("dept");
    expect(results.map((e) => e.name)).toContain("a/asset_owners");
    expect(matchSnippet(owners, matches?.get(owners.id))).toEqual({ where: "field", text: "dept" });
    expect(s.query("", { field: ["score"] }).results.map((e) => e.name)).toEqual(["a/threats"]);
  });
});
