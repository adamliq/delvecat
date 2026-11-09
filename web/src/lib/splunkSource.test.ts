import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchSplunkCatalog, splunkdUrl } from "./splunkSource";

describe("splunkdUrl", () => {
  it("keeps the locale and any root endpoint of the page", () => {
    const p = "/servicesNS/nobody/delvecat/x";
    expect(splunkdUrl(p, { pathname: "/en-US/app/delvecat/catalog" })).toBe(`/en-US/splunkd/__raw${p}`);
    expect(splunkdUrl(p, { pathname: "/splunk/de-DE/app/delvecat/catalog" })).toBe(
      `/splunk/de-DE/splunkd/__raw${p}`,
    );
  });
});

const bundle = { schemaVersion: "0.1.0", generatedAt: "2026-01-01T00:00:00Z", instances: [], entities: [], edges: [] };

function store(parts: number, generation = "g1") {
  const packed = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const text = packed.toString("base64");
  const size = Math.ceil(text.length / parts);
  const docs = new Map<string, unknown>();
  for (let n = 0; n < parts; n++) docs.set(`${generation}-${n}`, { data: text.slice(n * size, (n + 1) * size) });
  docs.set("current", {
    generation,
    parts,
    sha256: createHash("sha256").update(packed).digest("hex"),
    bytes: packed.length,
    encoding: "gzip+base64",
  });
  return docs;
}

function fetcher(docs: Map<string, unknown>, status?: number) {
  return async (url: string) => {
    const key = decodeURIComponent(/delvecat_catalog\/([^?]+)/.exec(url)![1]);
    if (status) return new Response("", { status });
    const doc = docs.get(key);
    return doc ? new Response(JSON.stringify(doc)) : new Response("", { status: 404 });
  };
}

describe("fetchSplunkCatalog", () => {
  it("joins the parts, checks the hash and parses the bundle", async () => {
    const r = await fetchSplunkCatalog(fetcher(store(3)));
    expect(r?.bundle.schemaVersion).toBe("0.1.0");
    expect(r?.pointer.parts).toBe(3);
  });

  it("returns null when nothing is published", async () => {
    expect(await fetchSplunkCatalog(fetcher(new Map()))).toBeNull();
  });

  it("rejects a corrupt catalog", async () => {
    const docs = store(2);
    docs.set("g1-1", { data: "AAAA" });
    await expect(fetchSplunkCatalog(fetcher(docs))).rejects.toThrow(/corrupt/);
  });

  it("explains a permission error", async () => {
    await expect(fetchSplunkCatalog(fetcher(new Map(), 403))).rejects.toThrow(/delvecat_user/);
  });

  it("retries when a newer catalog replaces the parts mid-load", async () => {
    const old = store(2, "g1");
    const fresh = store(1, "g2");
    let calls = 0;
    const r = await fetchSplunkCatalog(async (url) => {
      const key = decodeURIComponent(/delvecat_catalog\/([^?]+)/.exec(url)![1]);
      calls++;
      const docs = calls === 1 ? old : fresh; // the pointer read first is the old one
      const doc = docs.get(key);
      return doc ? new Response(JSON.stringify(doc)) : new Response("", { status: 404 });
    });
    expect(r?.pointer.generation).toBe("g2");
  });
});

import { ALL_PARTS, DEFAULT_PARTS, buildSearch, formKey, splQuote, withNeeds } from "./splunkBuild";

describe("build search", () => {
  it("quotes values so they cannot add arguments or commands", () => {
    expect(splQuote('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(
      buildSearch({
        parts: ["fields", "indexes"],
        searchTimeout: 120,
        redact: "internal",
        instance: "prod",
        instanceName: 'x" | delete',
        webUrl: "https://sh",
        replaceSmaller: true,
      }),
    ).toBe(
      '| delvecatbuild parts="indexes,inventory,fields" searchtimeout=120 redact=internal instance="prod" ' +
        'instancename="x\\" | delete" weburl="https://sh" replacesmaller=true',
    );
  });

  it("lists every part once, adds what parts need, and leaves field discovery out by default", () => {
    expect(new Set(ALL_PARTS).size).toBe(ALL_PARTS.length);
    expect(withNeeds(["fields"])).toEqual(["inventory", "fields"]);
    expect(DEFAULT_PARTS).not.toContain("fields");
    expect(DEFAULT_PARTS.length).toBe(ALL_PARTS.length - 1);
  });

  it("reads Splunk Web's CSRF cookie", () => {
    expect(formKey("a=1; splunkweb_csrf_token_8000=abc%3D; b=2")).toBe("abc=");
    expect(formKey("a=1")).toBeNull();
  });
});
