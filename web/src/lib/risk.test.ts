import { describe, expect, it } from "vitest";
import type { CatalogBundle, Edge, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { atRiskFrom, problems, riskMap } from "./risk";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const E = (a: Entity, type: Edge["type"], b: Entity): Edge => ({ from: a.id, to: b.id, type });

const input = ent("input", "fw", { health: { status: "critical", checks: [{ check: "silent", status: "critical", message: "no data for 3 days" }] } });
const idx = ent("index", "firewall");
const det = ent("correlationSearch", "Port scan");
const board = ent("dashboard", "SOC");
const action = ent("adaptiveResponseAction", "notable", { lineage: { unresolved: ["macro:gone"] } });
const other = ent("correlationSearch", "Other");
const off = ent("savedSearch", "rollup", { disabled: true });
const summary = ent("index", "summary");
const offReader = ent("savedSearch", "old", { disabled: true });
const afterOff = ent("dashboard", "after");

const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [input, idx, det, board, action, other, off, summary, offReader, afterOff],
  edges: [
    E(input, "feeds", idx), E(det, "reads", idx), E(board, "reads", det),
    E(det, "triggers", action), E(other, "triggers", action),
    E(off, "writes", summary), E(offReader, "reads", idx), E(afterOff, "reads", offReader),
  ],
};
const c = new Catalog(bundle);

describe("downstream risk", () => {
  it("lists an object's own problems", () => {
    expect(problems(input).map((p) => p.severity)).toEqual(["critical"]);
    expect(problems(action)[0].summary).toBe("missing macro:gone");
    expect(problems(off)[0].kind).toBe("disabled");
    expect(problems(idx)).toEqual([]);
  });

  it("propagates through dependencies with depth and path", () => {
    const r = riskMap(c);
    expect(r.get(idx.id)?.severity).toBe("critical");
    expect(r.get(idx.id)?.causes[0]).toMatchObject({ depth: 1, via: undefined });
    const boardRisk = r.get(board.id)!;
    expect(boardRisk.causes.map((x) => [x.root.name, x.depth, x.via?.name])).toEqual([
      ["notable", 2, "Port scan"],
      ["fw", 3, "Port scan"],
    ]);
  });

  it("puts triggering detections at risk, not the other way round", () => {
    const r = riskMap(c);
    expect(r.get(det.id)?.causes.map((x) => x.root.name).sort()).toEqual(["fw", "notable"]);
    expect(r.get(other.id)?.causes.map((x) => x.root.name)).toEqual(["notable"]);
    expect(r.has(action.id)).toBe(false);
  });

  it("flags readers of data a disabled search writes, and stops at disabled objects", () => {
    const r = riskMap(c);
    expect(r.get(summary.id)?.causes[0]).toMatchObject({ root: off, depth: 1 });
    expect(r.has(offReader.id)).toBe(false);
    expect(r.get(afterOff.id)?.causes.map((x) => x.root.name)).toEqual(["old"]);
  });

  it("lists what one problem puts at risk", () => {
    expect(atRiskFrom(c, input.id).map((x) => [x.entity.name, x.cause.depth])).toEqual([["firewall", 1], ["Port scan", 2], ["SOC", 3]]);
  });
});

describe("shared producers", () => {
  const bad = ent("sourcetype", "bad", { health: { status: "critical", checks: [{ check: "parsing", status: "critical", message: "line breaking" }] } });
  const good = ent("sourcetype", "good");
  const internal = ent("index", "_internal");
  const reader = ent("savedSearch", "errors");
  const d1 = ent("correlationSearch", "d1", { disabled: true });
  const d2 = ent("correlationSearch", "d2");
  const notable = ent("index", "notable");
  const b: CatalogBundle = {
    ...bundle,
    entities: [bad, good, internal, reader, d1, d2, notable],
    edges: [E(bad, "feeds", internal), E(good, "feeds", internal), E(reader, "reads", internal), E(d1, "writes", notable), E(d2, "writes", notable)],
  };
  const r = riskMap(new Catalog(b));

  it("flags a target with several producers as partly at risk, without spreading", () => {
    expect(r.get(internal.id)).toMatchObject({ severity: "warning", causes: [{ root: bad, partial: true }] });
    expect(r.has(reader.id)).toBe(false);
  });

  it("ignores one disabled producer among several", () => {
    expect(r.has(notable.id)).toBe(false);
  });
});
