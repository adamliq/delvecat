import { describe, expect, it } from "vitest";
import { recentIds, rememberViewed } from "./recent";
import { savedTheme, splunkTheme } from "./theme";

describe("recently viewed", () => {
  it("keeps the newest first, without repeats, at most 12", () => {
    for (let i = 0; i < 15; i++) rememberViewed(`id${i}`);
    rememberViewed("id5");
    const ids = recentIds();
    expect(ids[0]).toBe("id5");
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});

describe("theme", () => {
  it("defaults to automatic", () => {
    expect(savedTheme()).toBe("auto");
  });

  it("reads the user's Splunk theme", async () => {
    const reply = (theme: string | undefined) => async () => new Response(JSON.stringify({ entry: [{ content: { theme } }] }));
    expect(await splunkTheme(reply("dark"))).toBe("dark");
    expect(await splunkTheme(reply("enterprise"))).toBe("light");
    expect(await splunkTheme(reply(undefined))).toBeNull();
    expect(await splunkTheme(async () => new Response("", { status: 403 }))).toBeNull();
  });
});
