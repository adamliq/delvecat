import { describe, expect, it } from "vitest";
import { parseJsonBytes } from "./bigJson";
import { BundleError, parseBundleBytes } from "./catalog";

const enc = (s: string) => new TextEncoder().encode(s);

const sample = {
  schemaVersion: "0.2.0",
  modelVersion: "0.1.2",
  instances: [{ id: "s1", name: "Stack, \"one\"", kind: "splunkEnterprise" }],
  entities: Array.from({ length: 300 }, (_, i) => ({
    id: `s1:index:i${i}`,
    name: i % 7 ? `idx_${i}` : `ünïçødé ${i} \\ "q" ] } , [ {`,
    nested: { list: [i, -i / 3, true, null, "x"], deeper: { s: "a\nb\tc" } },
    empty: [],
    obj: {},
  })),
  edges: [],
  edgeTable: { ids: ["a", "b"], types: ["reads"], origins: [], rows: Array.from({ length: 4000 }, (_, i) => (i % 4 === 3 ? -1 : i % 2)) },
};

describe("parseJsonBytes", () => {
  const text = JSON.stringify(sample);
  const pretty = JSON.stringify(sample, null, 2);

  it.each([
    ["whole", text, undefined],
    ["split, small limit", text, 200],
    ["split, tiny limit", text, 40],
    ["pretty-printed, split", pretty, 64],
  ])("%s reads the same as JSON.parse", (_name, src, limit) => {
    expect(parseJsonBytes(enc(src), limit)).toEqual(JSON.parse(src));
  });

  it("reads a list whose single item is larger than the limit", () => {
    const big = { entities: [{ id: "x", blob: "y".repeat(30), tags: Array(40).fill("t") }, 1, { id: "z", more: Array(200).fill("w") }] };
    const src = JSON.stringify(big);
    expect(parseJsonBytes(enc(src), 50)).toEqual(big);
  });

  it("reads empty lists and objects at the top level", () => {
    expect(parseJsonBytes(enc(' { "a" : [ ] , "b" : { } } '), 4)).toEqual({ a: [], b: {} });
  });

  it("rejects broken JSON on the split path", () => {
    expect(() => parseJsonBytes(enc('{"a": [1, 2,, 3]}'), 4)).toThrow();
    expect(() => parseJsonBytes(enc('{"a": [1, 2] "b": 1}'), 4)).toThrow();
    expect(() => parseJsonBytes(enc('{"a": "unterminated}'), 4)).toThrow();
  });

  it("refuses a single string too large to read", () => {
    expect(() => parseJsonBytes(enc(JSON.stringify({ a: "z".repeat(100) })), 20)).toThrow(/too large/);
  });
});

describe("parseBundleBytes", () => {
  it("expands a stored catalog from bytes", () => {
    const b = parseBundleBytes(enc(JSON.stringify(sample)));
    expect(b.schemaVersion).toBe("0.1.2");
    expect(b.entities).toHaveLength(300);
    expect(b.edges).toHaveLength(1000);
    expect(b.edges[0]).toEqual({ from: "a", to: "b", type: "reads" });
  });

  it("says when the bytes are not JSON", () => {
    expect(() => parseBundleBytes(enc("not json"))).toThrow(BundleError);
  });
});
