import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { Catalog } from "./catalog";
import { coverage, dataModelCoverage, detectionStatus, type AttackData } from "./coverage";

const attack: AttackData = {
  attribution: "test",
  tactics: [
    { id: "TA0006", shortname: "credential-access", name: "Credential Access" },
    { id: "TA0002", shortname: "execution", name: "Execution" },
  ],
  techniques: [
    { id: "T1110", name: "Brute Force", tactics: ["credential-access"] },
    { id: "T1110.001", name: "Password Guessing", tactics: ["credential-access"], parent: "T1110" },
    { id: "T1003", name: "OS Credential Dumping", tactics: ["credential-access"] },
    { id: "T1059", name: "Command and Scripting Interpreter", tactics: ["execution"] },
    { id: "T1059.001", name: "PowerShell", tactics: ["execution"], parent: "T1059" },
  ],
};

const e = (id: string, type: Entity["type"], extra: Partial<Entity> = {}): Entity => ({
  id, type, name: id.split(":").pop()!.split("/").pop()!, product: "splunk", instance: "i", ...extra,
});
const det = (name: string, mitre: string[], extra: Partial<Entity> = {}) =>
  e(`i:correlationSearch:es/${name}`, "correlationSearch", { properties: { mitreAttack: mitre }, ...extra });

const entities: Entity[] = [
  e("i:index:auth", "index", { properties: { observed: { totalEventCount: 10 } } }),
  e("i:index:empty", "index", { properties: { observed: { totalEventCount: 0 } } }),
  e("i:dataModel:cim/Authentication", "dataModel", { name: "Authentication", properties: { accelerated: true } }),
  det("brute", ["T1110.001"]),
  det("dump", ["T1003"], { disabled: true }),
  det("ps", ["T1059.001"], { lineage: { unresolved: ["dataModel:Endpoint"] } }),
  det("quiet", ["T1003", "T9999"]),
];
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities,
  edges: [
    { from: "i:dataModel:cim/Authentication", to: "i:index:auth", type: "reads" },
    { from: "i:correlationSearch:es/brute", to: "i:dataModel:cim/Authentication", type: "reads" },
    { from: "i:correlationSearch:es/quiet", to: "i:index:empty", type: "reads" },
  ],
};
const c = new Catalog(bundle);

describe("coverage", () => {
  it("classifies why a detection can or cannot fire", () => {
    const states = Object.fromEntries(c.entities.filter((x) => x.type === "correlationSearch")
      .map((x) => [x.name, detectionStatus(c, x).state]));
    expect(states).toEqual({ brute: "ready", dump: "disabled", ps: "broken", quiet: "noData" });
  });

  it("rolls sub-techniques up and grades cells", () => {
    const cov = coverage(c, attack);
    const cells = Object.fromEntries(cov.columns.flatMap((col) => col.cells).map((x) => [x.id, [x.state, x.detections.length]]));
    expect(cells).toEqual({ T1110: ["covered", 1], T1003: ["weak", 2], T1059: ["weak", 1] });
    expect([cov.topLevelCovered, cov.topLevelWeak, cov.topLevelTotal]).toEqual([1, 2, 3]);
    expect(cov.unknownTechniques).toEqual(["T9999"]);
    expect(cov.columns.map((col) => col.cells.length)).toEqual([2, 1]);
  });

  it("reports data models detections rely on, including missing ones", () => {
    const models = dataModelCoverage(c, coverage(c, attack).detections);
    expect(models.map((m) => [m.name, Boolean(m.entity), m.hasData, m.accelerated])).toEqual([
      ["Authentication", true, true, true],
      ["Endpoint", false, false, false],
    ]);
  });
});
