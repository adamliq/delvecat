import { describe, expect, it } from "vitest";
import { recentTargets, rememberTarget, testConnection } from "./connectivity";

describe("connection test client", () => {
  it("posts the address, token and options to the app's endpoint", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = { target: "sh2:8089", ok: true, steps: [] };
    const r = await testConnection({ url: "https://sh2:8089", token: "t", verify: false }, async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(result), { status: 200 });
    });
    expect(r).toEqual(result);
    expect(seen!.url).toContain("/splunkd/__raw/services/delvecat/connectivity");
    expect(seen!.init!.method).toBe("POST");
    expect(JSON.parse(String(seen!.init!.body))).toEqual({ url: "https://sh2:8089", token: "t", verify: false });
  });

  it("explains refusals and a missing endpoint", async () => {
    await expect(testConnection({ url: "x", verify: true }, async () => new Response(JSON.stringify({ error: "Only catalog publishers" }), { status: 403 })))
      .rejects.toThrow(/Only catalog publishers/);
    await expect(testConnection({ url: "x", verify: true }, async () => new Response("", { status: 404 })))
      .rejects.toThrow(/update the app/);
  });

  it("remembers recent addresses (never tokens), newest first", () => {
    rememberTarget("https://a:8089");
    rememberTarget("https://b:8089");
    rememberTarget("https://a:8089");
    expect(recentTargets().slice(0, 2)).toEqual(["https://a:8089", "https://b:8089"]);
  });
});
