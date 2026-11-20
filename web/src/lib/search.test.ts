import { describe, expect, it } from "vitest";
import type { Entity, EntityType } from "../generated/catalog";
import { EntitySearch, propertyValues } from "./search";

const ent = (type: EntityType, name: string, properties: Record<string, unknown> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", properties });

describe("search by values", () => {
  const acct = ent("addOnAccount", "prod_app", { tenantId: "0f1e2d3c-aaaa-bbbb-cccc-111122223333", cloudEnvironment: "Azure Public Cloud" });
  const out = ent("outputGroup", "tcpout:siem", { servers: ["siem1.acme.example:9997"] });
  const idx = ent("index", "web", { storage: { tiers: [{ tier: "warm", bucket: "acme-smartstore", provider: "Amazon S3" }] } });
  const search = new EntitySearch([acct, out, idx]);

  it("finds an object by a value it holds", () => {
    expect(search.search("0f1e2d3c-aaaa-bbbb-cccc-111122223333").map((e) => e.name)).toEqual(["prod_app"]);
    expect(search.search("siem1.acme.example").map((e) => e.name)).toEqual(["tcpout:siem"]);
    expect(search.search("acme-smartstore").map((e) => e.name)).toEqual(["web"]);
  });

  it("collects short text values, not dates or long text", () => {
    const values = propertyValues({ a: "x1", b: "2026-11-19T20:50:17Z", c: "y".repeat(300), d: ["z1", { e: "w1" }], search: "index=web" });
    expect(values).toEqual(["x1", "z1", "w1"]);
  });
});
