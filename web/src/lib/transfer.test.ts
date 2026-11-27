import { describe, expect, it } from "vitest";
import type { CatalogBundle } from "../generated/catalog";
import { bytesToBase64, exportName, gzipBundle, importCatalog } from "./transfer";

describe("export and import", () => {
  it("names the file after the instances and the day", () => {
    expect(exportName({ instances: [{ id: "sh1" }, { id: "es:1" }] } as CatalogBundle)).toMatch(/^delvecat-sh1\+es_1-\d{4}-\d{2}-\d{2}\.json\.gz$/);
  });

  it("gzips the catalog in its stored form, without its shard list", async () => {
    const blob = await gzipBundle({ schemaVersion: "0.1.0", instances: [{ id: "a" }], entities: [], edges: [], shards: [{ path: "x" }] } as unknown as CatalogBundle);
    const text = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text)).toEqual({
      schemaVersion: "0.2.0", modelVersion: "0.1.0", instances: [{ id: "a" }], entities: [], edges: [],
      edgeTable: { ids: [], types: [], origins: [], rows: [] },
    });
  });

  it("encodes large files to base64 in chunks", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const b64 = bytesToBase64(bytes);
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it("posts imports to the app's endpoint and explains failures", async () => {
    let body: unknown;
    const ok = await importCatalog({ source: "stack", url: "https://es:8089", token: "t", verify: true, mode: "combine" }, async (url, init) => {
      expect(url).toContain("/services/delvecat/transfer");
      body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ mode: "combine", before: 1, after: 2, importedInstances: ["es"], instances: [], source: "stack es:8089" }));
    });
    expect(ok.after).toBe(2);
    expect(body).toMatchObject({ source: "stack", mode: "combine" });
    await expect(importCatalog({ source: "file", data: "", mode: "replace" }, async () => new Response(JSON.stringify({ error: "Not a catalog" }), { status: 400 }))).rejects.toThrow(/Not a catalog/);
    await expect(importCatalog({ source: "file", data: "", mode: "replace" }, async () => new Response("", { status: 404 }))).rejects.toThrow(/update the app/);
  });
});
