import { describe as group, expect, it } from "vitest";
import { describe, fromCron, readSchedule, saveSchedule, toCron } from "./schedule";

group("scheduled builds", () => {
  it("turns daily and weekly times into cron and back", () => {
    expect(toCron({ frequency: "daily", hour: 2, minute: 17, day: 1, cron: "" })).toBe("17 2 * * *");
    expect(toCron({ frequency: "weekly", hour: 3, minute: 30, day: 1, cron: "" })).toBe("30 3 * * 1");
    expect(toCron({ frequency: "custom", hour: 0, minute: 0, day: 0, cron: " 0 */6 * * * " })).toBe("0 */6 * * *");
    expect(fromCron("30 3 * * 1")).toMatchObject({ frequency: "weekly", hour: 3, minute: 30, day: 1 });
    expect(fromCron("0 */6 * * *").frequency).toBe("custom");
    expect(describe("17 2 * * *")).toBe("every day at 02:17");
    expect(describe("30 3 * * 1")).toBe("every Monday at 03:30");
  });

  it("reads the app's report and saves only it", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method) {
        return new Response(JSON.stringify({ entry: [{ content: { disabled: false, is_scheduled: true, cron_schedule: "17 2 * * *", search: "| delvecatbuild", next_scheduled_time: "2026-11-25 02:17:00 UTC" }, acl: { can_write: true } }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const s = await readSchedule(fetchFn);
    expect(s).toMatchObject({ enabled: true, cron: "17 2 * * *", canWrite: true });
    await saveSchedule({ enabled: false, cron: "30 3 * * 1", search: '| delvecatbuild parts="apps"' }, fetchFn);
    const post = calls[1];
    expect(post.url).toContain("/saved/searches/Licoryx%20Delvecat%20-%20scheduled%20build");
    const body = new URLSearchParams(String(post.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({ disabled: "1", cron_schedule: "30 3 * * 1", is_scheduled: "1", search: '| delvecatbuild parts="apps"' });
  });
});
