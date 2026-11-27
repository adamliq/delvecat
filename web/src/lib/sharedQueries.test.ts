import { describe, expect, it } from "vitest";
import { queryKey, sharedQueryStore } from "./sharedQueries";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("shared SQL queries", () => {
  it("keys a name the same way whatever its case and spacing (sharing again replaces it)", () => {
    expect(queryKey("Busy searches")).toBe(queryKey("  busy searches "));
    expect(queryKey("Busy searches")).not.toBe(queryKey("Busy search"));
    expect(queryKey("x")).toMatch(/^q-[0-9a-f]{16}$/);
  });

  it("lists by name, and treats a missing or unreadable collection as none", async () => {
    const rows = [{ _key: "q-2", name: "b", sql: "SELECT 2", at: "x" }, { _key: "q-1", name: "a", sql: "SELECT 1", at: "x" }, { _key: "q-3", name: "", sql: "", at: "x" }];
    expect((await sharedQueryStore(async () => json(200, rows)).list()).map((q) => q.name)).toEqual(["a", "b"]);
    expect(await sharedQueryStore(async () => json(404, {})).list()).toEqual([]);
    expect(await sharedQueryStore(async () => json(403, {})).list()).toEqual([]);
  });

  it("shares with the viewer's name, and says why it cannot", async () => {
    const sent: unknown[] = [];
    const ok = sharedQueryStore(async (url, init) => {
      if (url.includes("current-context")) return json(200, { entry: [{ content: { username: "pat" } }] });
      sent.push(JSON.parse(String(init?.body)));
      return json(200, ["q"]);
    });
    const q = await ok.share(" Busy searches ", "SELECT 1 ");
    expect(q).toMatchObject({ name: "Busy searches", sql: "SELECT 1", _key: queryKey("Busy searches") });
    expect((sent[0] as { name: string }[])[0].name).toBe("Busy searches");
    await expect(sharedQueryStore(async (u) => (u.includes("current-context") ? json(200, {}) : json(403, {}))).share("a", "b")).rejects.toThrow(/publishers/);
    await expect(sharedQueryStore(async (u) => (u.includes("current-context") ? json(200, {}) : json(404, {}))).share("a", "b")).rejects.toThrow(/0\.47\.0/);
  });
});
