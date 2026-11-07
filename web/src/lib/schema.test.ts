import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { fieldsOfTerm, termsOfField } from "./glossaryFields";
import { kpis } from "./insights";
import { problems } from "./risk";
import { cimCoverage, compareSchemas, dataModelFields, dataModelsOf, fieldType, nullRate, similarSchemas } from "./schema";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const E = (a: Entity, type: Edge["type"], b: Entity): Edge => ({ from: a.id, to: b.id, type });
const fld = (st: string, n: string, numeric: boolean | undefined, coverage?: number) =>
  ent("field", `${st}/${n}`, { displayName: n, properties: { sourcetype: st, field: n, ...(numeric === undefined ? {} : { numeric }), ...(coverage === undefined ? {} : { observed: { coverage, distinctCount: 3 } }) } });

const fw = ent("sourcetype", "fw");
const web = ent("sourcetype", "web");
const fwF = [fld("fw", "src_ip", false, 1), fld("fw", "dest_port", true, 1), fld("fw", "action", false, 0.8), fld("fw", "vendor", undefined)];
const webF = [fld("web", "src_ip", false, 1), fld("web", "dest_port", false, 1), fld("web", "status", true, 1)];
const tag = ent("tag", "network");
const dm = ent("dataModel", "Network_Traffic", { properties: { datasets: [{ name: "All_Traffic", fields: ["_time", "host", "All_Traffic"] }] } });
const dmOwn = ent("dataModel", "Own", { properties: { datasets: [{ name: "Root", fields: ["Root.status", "Root.uri", "Root.method"] }] } });

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [fw, web, ...fwF, ...webF, tag, dm, dmOwn],
  edges: [...fwF.map((f) => E(fw, "contains", f)), ...webF.map((f) => E(web, "contains", f)), E(tag, "mapsTo", fw), E(dm, "uses", tag), E(dmOwn, "reads", web)],
  glossary: [{ term: "Source address", fields: ["src_ip"] }],
};
const c = new Catalog(bundle);

describe("schemas", () => {
  it("types fields and measures null rates", () => {
    expect(fwF.map(fieldType)).toEqual(["string", "number", "string", "unknown"]);
    expect(nullRate(fwF[2])).toBeCloseTo(0.2);
    expect(nullRate(fwF[3])).toBeUndefined();
  });

  it("finds data models through tags or direct reads, falling back to the CIM reference", () => {
    expect(dataModelsOf(c, fw).map((m) => m.name)).toEqual(["Network_Traffic"]);
    expect(dataModelsOf(c, web).map((m) => m.name)).toEqual(["Own"]);
    expect(dataModelFields(dm).fromReference).toBe(true);
    expect(dataModelFields(dmOwn)).toEqual({ names: new Set(["status", "uri", "method"]), fromReference: false });
    const cov = cimCoverage(c, fw);
    expect([...cov.cimFields].sort()).toEqual(["action", "dest_port", "src_ip"]);
    expect(cov.pct).toBe(75);
  });

  it("compares and ranks similar schemas", () => {
    const rows = compareSchemas(c, fw, web);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["action", "onlyA"], ["dest_port", "differs"], ["src_ip", "same"], ["status", "onlyB"], ["vendor", "onlyA"],
    ]);
    const sim = similarSchemas(c, fw);
    expect(sim.map((s) => [s.entity.name, s.shared, Math.round(s.score * 100)])).toEqual([["web", ["dest_port", "src_ip"], 40]]);
  });

  it("links glossary terms to fields by name", () => {
    expect(termsOfField(c, fwF[0])).toEqual(["Source address"]);
    expect(fieldsOfTerm(c, bundle.glossary![0]).map((f) => f.name).sort()).toEqual(["fw/src_ip", "web/src_ip"]);
  });

  it("counts failing quality checks as a risk, but not health ones twice", () => {
    const st = ent("sourcetype", "q", { quality: { passed: 0, failed: 2, tests: [
      { test: "fresh", expectation: "", result: "No new events", status: "fail", source: "default" },
      { test: "notNull", field: "src_ip", expectation: "", result: "80% filled", status: "fail", source: "default" },
    ] } });
    expect(problems(st).map((p) => [p.kind, p.summary])).toEqual([["quality", "data quality: src_ip 80% filled"]]);
  });

  it("computes KPIs against targets", () => {
    const k = Object.fromEntries(kpis(c, true, { fieldsInCim: [3, 4], fieldsWithTerm: [2, 7] }).map((x) => [x.key, x]));
    expect(k.cim.value).toBe(75);
    expect(k.terms.value).toBe(29);
    expect(k.quality.value).toBeUndefined();
  });
});
