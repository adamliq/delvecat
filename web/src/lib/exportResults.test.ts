import { describe, expect, it } from "vitest";
import type { Entity } from "../generated/catalog";
import { toCsv } from "./health";
import { exportFileName, resultRows } from "./exportResults";
import type { Risk } from "./risk";
import type { PropertyDef } from "./structured";

const root: Entity = { id: "i:input:fw", type: "input", name: "fw", product: "splunk", instance: "i" };
const idx: Entity = {
  id: "i:index:firewall", type: "index", name: "firewall", product: "splunk", instance: "i", app: "search",
  description: "from Splunk", sourceUrl: "https://splunk.example/idx",
  annotations: { description: "Perimeter logs", owners: ["net", "soc"], tags: ["fw"], domain: "Security", properties: { tier: "hot", scope: ["PCI-DSS", "SOX"] } },
  health: { status: "warning", checks: [{ check: "volume", status: "warning", message: "low volume" }, { check: "fresh", status: "ok", message: "fine" }] },
  usage: { unused: false, lastUsed: "2026-11-01T00:00:00Z" },
};
const bare: Entity = { id: "i:macro:m", type: "macro", name: "=cmd|calc", product: "splunk", instance: "i", disabled: true };
const defs: PropertyDef[] = [{ id: "tier", displayName: "Retention tier", type: "string" }, { id: "scope", type: "string" }];
const risk = new Map<string, Risk>([[idx.id, { severity: "critical", causes: [{ root, problems: [], depth: 1 }] }]]);

describe("search results export", () => {
  const rows = resultRows([idx, bare], { instanceNames: { i: "Acme" }, defs, risk, baseUrl: "https://x.github.io/delvecat/" });
  const col = (r: number, name: string) => rows[r][rows[0].indexOf(name)];

  it("has one row per object and a column per structured property", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0].slice(-2)).toEqual(["Retention tier", "scope"]);
    for (const r of rows) expect(r).toHaveLength(rows[0].length);
  });

  it("fills in annotations, health, risk and links", () => {
    expect(col(1, "type")).toBe("Index");
    expect(col(1, "instance")).toBe("Acme");
    expect(col(1, "description")).toBe("Perimeter logs");
    expect(col(1, "owners")).toBe("net; soc");
    expect(col(1, "health findings")).toBe("low volume");
    expect(col(1, "at risk")).toBe("critical");
    expect(col(1, "at risk from")).toBe("i:input:fw");
    expect(col(1, "catalog link")).toBe("https://x.github.io/delvecat/#/entity/i%3Aindex%3Afirewall");
    expect(col(1, "Retention tier")).toBe("hot");
    expect(col(1, "scope")).toBe("PCI-DSS; SOX");
    expect(col(2, "status")).toBe("disabled");
    expect(col(2, "at risk")).toBeUndefined();
  });

  it("defuses formula-like names in the CSV", () => {
    expect(toCsv(rows)).toContain(`"'=cmd|calc"`);
  });

  it("names the file after the query", () => {
    const d = new Date("2026-11-07T10:00:00Z");
    expect(exportFileName("Firewall  Denied!", d)).toBe("delvecat-firewall-denied-2026-11-07.csv");
    expect(exportFileName("", d)).toBe("delvecat-catalog-2026-11-07.csv");
  });
});
