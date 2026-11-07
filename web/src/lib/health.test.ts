import { describe, expect, it } from "vitest";
import type { Entity } from "../generated/catalog";
import { EntitySearch } from "./search";
import { dailySeries, dayLabel, healthStatus, toCsv } from "./health";

const e = (over: Partial<Entity>): Entity => ({ id: "i:index:x", type: "index", name: "x", product: "splunk", instance: "i", ...over });

describe("health helpers", () => {
  it("quotes CSV values", () => {
    expect(toCsv([["a", 'b "c"', undefined], [1, "x,y", "z"]])).toBe('"a","b ""c""",""\n"1","x,y","z"\n');
  });
  it("defuses spreadsheet formulas in text but keeps negative numbers", () => {
    expect(toCsv([["=HYPERLINK(\"x\")", "@SUM(1)", "+1", "-cmd", "\tx", -5, "a=b"]]))
      .toBe(`"'=HYPERLINK(""x"")","'@SUM(1)","'+1","'-cmd","'\tx","-5","a=b"\n`);
  });
  it("labels days from a start date across month ends", () => {
    expect(dayLabel("2026-10-30", 0)).toBe("2026-10-30");
    expect(dayLabel("2026-10-30", 3)).toBe("2026-11-02");
  });
  it("reads status and series", () => {
    expect(healthStatus(e({}))).toBe("ok");
    expect(healthStatus(e({ health: { status: "critical", checks: [] } }))).toBe("critical");
    expect(dailySeries(e({ properties: { observed: { dailyEvents: { start: "2026-11-01", counts: [1, 2] } } } }))?.counts).toEqual([1, 2]);
    expect(dailySeries(e({}))).toBeNull();
  });
  it("offers health and usage facets", () => {
    const s = new EntitySearch([
      e({ id: "a", name: "a", health: { status: "warning", checks: [] } }),
      e({ id: "b", name: "b", usage: { unused: true, builtin: true } }),
      e({ id: "c", name: "c", usage: { unused: true } }),
    ]);
    expect(s.query("", { health: ["warning"] }).results.map((r) => r.name)).toEqual(["a"]);
    expect(Object.fromEntries(s.query("").facets.usage)).toEqual({ unused: 1, "unused (built-in)": 1 });
  });
});
