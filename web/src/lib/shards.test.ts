import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { BundleError, Catalog, inlineShards, openLocalFiles } from "./catalog";
import { relationGroups } from "./relations";

const enc = new TextEncoder();
const entitiesShard = JSON.stringify({
  entities: [
    { id: "i:role:soc", type: "role", name: "soc", product: "splunk", instance: "i" },
    { id: "i:index:fw", type: "index", name: "fw", product: "splunk", instance: "i" },
    { id: "i:user:jlee", type: "user", name: "jlee", product: "splunk", instance: "i" },
  ],
});
const edgesShard = JSON.stringify({
  edges: [
    { from: "i:role:soc", to: "i:index:fw", type: "grantsAccess" },
    { from: "i:user:jlee", to: "i:role:soc", type: "memberOf" },
  ],
});
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let manifest: CatalogBundle;
beforeAll(async () => {
  manifest = {
  schemaVersion: "0.1.1",
  generatedAt: "2026-11-01T00:00:00Z",
  generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkCloud" }],
  entities: [],
  edges: [],
  shards: [
    { path: "entities/mixed.json", kind: "entities", count: 3, sha256: await sha(entitiesShard) },
    { path: "edges.json", kind: "edges", count: 2, sha256: await sha(edgesShard) },
  ],
  };
});
const files: Record<string, string> = { "entities/mixed.json": entitiesShard, "edges.json": edgesShard };
const read = async (s: { path: string }) => enc.encode(files[s.path]).buffer as ArrayBuffer;

describe("inlineShards", () => {
  it("loads shards far larger than the call stack allows to spread (300,000 edges)", async () => {
    const big = JSON.stringify({ edges: Array.from({ length: 300_000 }, (_, i) => ({ from: `i:host:h${i}`, to: "i:index:fw", type: "feeds" })) });
    const m: CatalogBundle = { ...manifest, shards: [{ path: "edges.json", kind: "edges", count: 300_000, sha256: await sha(big) }] };
    const b = await inlineShards(m, async () => enc.encode(big).buffer as ArrayBuffer);
    expect(b.edges).toHaveLength(300_000);
  });

  it("loads and verifies shards", async () => {
    const b = await inlineShards(manifest, read);
    expect(b.entities).toHaveLength(3);
    expect(b.edges).toHaveLength(2);
    expect(b.shards).toBeUndefined();
  });
  it("rejects a corrupt shard", async () => {
    const bad = { ...manifest, shards: [{ ...manifest.shards![1], sha256: "0".repeat(64) }] };
    await expect(inlineShards(bad, read)).rejects.toThrow(/sha256/);
  });
});

describe("openLocalFiles", () => {
  const file = (path: string, body: string) => {
    const f = new File([body], path.split("/").pop()!);
    Object.defineProperty(f, "webkitRelativePath", { value: path });
    return f;
  };
  it("opens a folder selection", async () => {
    const { bundle, label } = await openLocalFiles([
      file("out/edges.json", edgesShard),
      file("out/catalog.json", JSON.stringify(manifest)),
      file("out/entities/mixed.json", entitiesShard),
    ]);
    expect(bundle.entities).toHaveLength(3);
    expect(label).toContain("folder");
  });
  it("explains a missing shard", async () => {
    await expect(openLocalFiles([file("catalog.json", JSON.stringify(manifest))])).rejects.toThrow(BundleError);
  });
});

describe("relationGroups", () => {
  it("labels both directions", async () => {
    const c = new Catalog(await inlineShards(manifest, read));
    const groups = relationGroups(c, "i:role:soc").map((g) => [g.label, g.entities.map((e) => e.name)]);
    expect(groups).toEqual([
      ["Can search (incl. inherited)", ["fw"]],
      ["Members", ["jlee"]],
    ]);
    expect(relationGroups(c, "i:index:fw")[0].label).toBe("Searchable by roles");
  });
});
