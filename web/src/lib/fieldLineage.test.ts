import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { derivedFrom, fieldDefiners, fieldImpact, fieldName, fieldReaders, usedFields } from "./fieldLineage";
import { riskMap } from "./risk";
import { catalogTables, EXAMPLES, fillDatabase, runQuery } from "./sql";

const require = createRequire(import.meta.url);
const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const E = (a: Entity, type: Edge["type"], b: Entity): Edge => ({ from: a.id, to: b.id, type });
const field = (st: string, f: string, extra: Partial<Entity> = {}) =>
  ent("field", `${st}/${f}`, { displayName: f, properties: { sourcetype: st, field: f }, ...extra });

const st = ent("sourcetype", "acme:fw");
const srcIp = field("acme:fw", "src_ip");
const src = field("acme:fw", "src", { properties: { sourcetype: "acme:fw", field: "src", definedIn: "configuration" } });
const action = field("acme:fw", "action");
const dest = field("acme:fw", "dest");
const destIp = field("acme:fw", "dest_ip");
const alias = ent("fieldAlias", "TA/acme:fw : FIELDALIAS-src", { properties: { aliases: { "0.src_ip": "src", "1.dest_ip": "dest" } } });
const extract = ent("fieldExtraction", "TA/acme:fw : EXTRACT-action", { disabled: true });
const det = ent("correlationSearch", "Port scan", {
  lineage: { fields: { source: "events", used: [{ name: "action", how: ["filter"] }, { name: "src", how: ["groupBy", "output"] }, { name: "nope", how: ["filter"] }],
    outputs: [{ name: "count", from: [] }, { name: "src", from: ["src"] }] } },
});
const board = ent("dashboard", "SOC");

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [st, srcIp, src, dest, destIp, action, alias, extract, det, board],
  edges: [
    E(st, "contains", srcIp), E(st, "contains", src), E(st, "contains", action),
    E(alias, "definesField", src), E(alias, "readsField", srcIp),
    E(alias, "definesField", dest), E(alias, "readsField", destIp), E(st, "uses", alias), E(extract, "definesField", action),
    E(det, "readsField", action), E(det, "readsField", src), E(board, "reads", det),
  ],
};
const c = new Catalog(bundle);

describe("field lineage", () => {
  it("lists the fields a search uses with what they matched", () => {
    const u = usedFields(c, det);
    expect(u.map((x) => [x.name, x.how, x.fields.map((f) => f.id)])).toEqual([
      ["action", ["filter"], [action.id]],
      ["src", ["groupBy", "output"], [src.id]],
      ["nope", ["filter"], []],
    ]);
    expect(fieldName(srcIp)).toBe("src_ip");
  });

  it("knows where a field comes from and who reads it", () => {
    expect(fieldDefiners(c, src).map((e) => e.id)).toEqual([alias.id]);
    expect(derivedFrom(c, src).map((e) => e.id)).toEqual([srcIp.id]);
    expect(derivedFrom(c, dest).map((e) => e.id)).toEqual([destIp.id]);
    const readers = fieldReaders(c, srcIp);
    expect(readers.map((r) => [r.entity.id, r.how, r.defines.map((f) => f.id)])).toEqual([[alias.id, [], [src.id]]]);
    expect(fieldReaders(c, action).map((r) => r.how)).toEqual([["filter"]]);
  });

  it("follows derived fields and downstream lineage for impact", () => {
    // Through the alias only to the field it makes from src_ip (not dest, not the sourcetype).
    expect(fieldImpact(c, srcIp).map((a) => [a.entity.name, a.depth, a.via?.name])).toEqual([
      [alias.name, 1, undefined],
      [src.name, 2, alias.name],
      ["Port scan", 3, src.name],
      ["SOC", 4, "Port scan"],
    ]);
  });

  it("puts readers of a field at risk when its only definition is disabled", () => {
    const r = riskMap(c);
    expect(r.get(action.id)?.causes[0].root.id).toBe(extract.id);
    expect(r.get(det.id)?.causes.map((x) => [x.root.id, x.depth])).toEqual([[extract.id, 2]]);
    expect(r.get(board.id)?.causes[0].depth).toBe(3);
  });

  it("exposes field usage and column lineage in SQL", async () => {
    const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    fillDatabase(db, catalogTables(bundle));
    expect(runQuery(db, "SELECT field, how, field_id FROM field_usage ORDER BY field").rows).toEqual([
      ["action", "filter", action.id], ["nope", "filter", null], ["src", "groupBy,output", src.id],
    ]);
    expect(runQuery(db, "SELECT column_name, source_field FROM column_lineage").rows).toEqual([["count", null], ["src", "src"]]);
    const ex = (t: string) => EXAMPLES.find((x) => x.title === t)!.sql;
    expect(runQuery(db, ex("Detections that break if a field disappears")).rows.map((r) => r[0]).sort()).toEqual(["action", "nope", "src"]);
    expect(runQuery(db, ex("Sourcetype fields nobody uses")).rows.map((r) => r[0])).toEqual([dest.id]);
  });
});
