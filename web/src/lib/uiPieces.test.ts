import { describe, expect, it } from "vitest";
import type { Entity, EntityType } from "../generated/catalog";
import { sortRows, type Column } from "../components/DataTable";
import { coverageSummary, partRows } from "./buildReport";
import { checkTitle, filterFindings, findings } from "./findings";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });

describe("sortable tables", () => {
  const col: Column<{ n?: number; s: string }> = { label: "n", value: (r) => r.n };
  const rows = [{ n: 10, s: "a" }, { s: "b" }, { n: 2, s: "c" }, { n: 33, s: "d" }];
  it("sorts numbers numerically and keeps empty values last both ways", () => {
    expect(sortRows(rows, col, "ascending").map((r) => r.s)).toEqual(["c", "a", "d", "b"]);
    expect(sortRows(rows, col, "descending").map((r) => r.s)).toEqual(["d", "a", "c", "b"]);
  });
  it("sorts text naturally", () => {
    const t: Column<string> = { label: "t", value: (r) => r };
    expect(sortRows(["web10", "web2", "Web1"], t, "ascending")).toEqual(["Web1", "web2", "web10"]);
  });
});

describe("findings", () => {
  const token = ent("authToken", "t1", { app: "search", health: { status: "critical", checks: [
    { check: "tokenNoOwner", status: "critical", message: "Its user no longer exists" },
    { check: "tokenStale", status: "warning", message: "Not used for 120 days" },
  ] } });
  const idx = ent("index", "web", { health: { status: "warning", checks: [{ check: "retentionBySize", status: "warning", message: "Uses 95%" }] } });
  const all = findings([token, idx, ent("index", "ok")]);
  it("lists every check, critical first", () => {
    expect(all.map((f) => f.check)).toEqual(["tokenNoOwner", "retentionBySize", "tokenStale"]);
    expect(checkTitle("tokenNoOwner")).toBe("Token without a user");
    expect(checkTitle("brandNew")).toBe("brandNew");
  });
  it("filters by severity, check, area, app and text", () => {
    expect(filterFindings(all, { status: "warning" })).toHaveLength(2);
    expect(filterFindings(all, { area: "Data" }).map((f) => f.entity.name)).toEqual(["web"]);
    expect(filterFindings(all, { app: "search", text: "120 days" }).map((f) => f.check)).toEqual(["tokenStale"]);
  });
});

describe("build report", () => {
  const rows = partRows([
    { connector: "splunk.authTokens", status: "ok", counts: { entities: 6 }, durationSecs: 0.4 } as never,
    { connector: "splunk.spl2", status: "skipped", message: "not available: orchestrator" },
    { connector: "enterpriseSecurity.queues", status: "failed", message: "boom" },
    { connector: "health", status: "ok" },
    { connector: "splunkbase.versions", status: "skipped", message: "not available: the Splunkbase Version Catalog app's catalogue is empty (enable its input)" },
  ]);
  it("names parts as the Build page does", () => {
    expect(rows.map((r) => [r.area, r.part, r.status])).toEqual([
      ["Splunk", "Authentication tokens (never their values)", "ok"],
      ["Splunk", "SPL2 modules, datasets and connections (Splunk 10+)", "skipped"],
      ["Enterprise Security", "Queues", "failed"],
      ["Processing", "Health and usage", "ok"],
      ["Splunkbase Version Catalog", "Versions", "skipped"],
    ]);
    expect(rows[0].objects).toBe(6);
    expect(rows[0].seconds).toBe(0.4);
    expect(coverageSummary(rows)).toBe("2 read, 2 skipped, 1 failed");
  });
});
