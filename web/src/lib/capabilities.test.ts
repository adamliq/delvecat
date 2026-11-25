import { describe, expect, it } from "vitest";
import type { CatalogBundle, Entity, EntityType } from "../generated/catalog";
import { Catalog } from "./catalog";
import { holders, isHighRisk, roleCapabilities, userCapabilities } from "./capabilities";

const ent = (type: EntityType, name: string, extra: Partial<Entity> = {}): Entity =>
  ({ id: `i:${type}:${name}`, type, name, product: "splunk", instance: "i", ...extra });
const editUser = ent("capability", "edit_user", { properties: { risk: "high" }, description: "create users" });
const search = ent("capability", "search");
const base = ent("role", "base", { properties: { capabilities: ["search"] } });
const ops = ent("role", "ops", { properties: { capabilities: ["edit_user"], importedCapabilities: ["search"] } });
const ann = ent("user", "ann");
const bob = ent("user", "bob");
const bundle: CatalogBundle = {
  schemaVersion: "0.1.2", generatedAt: "2026-01-01T00:00:00Z", generator: { name: "t", version: "0" },
  instances: [{ id: "i", name: "i", kind: "splunkEnterprise" }],
  entities: [editUser, search, base, ops, ann, bob],
  edges: [{ from: ann.id, to: ops.id, type: "memberOf" }, { from: bob.id, to: base.id, type: "memberOf" }],
};
const c = new Catalog(bundle);

describe("capabilities", () => {
  it("knows a role's own and inherited capabilities", () => {
    expect(roleCapabilities(ops)).toEqual({ own: ["edit_user"], inherited: ["search"] });
    expect(isHighRisk(editUser)).toBe(true);
    expect(isHighRisk(search)).toBe(false);
  });
  it("finds who holds a capability, directly, by inheriting, and users", () => {
    const h = holders(c, search);
    expect(h.direct.map((r) => r.name)).toEqual(["base"]);
    expect(h.inherited.map((r) => r.name)).toEqual(["ops"]);
    expect(h.users.map((u) => u.name).sort()).toEqual(["ann", "bob"]);
    expect(holders(c, editUser).users.map((u) => u.name)).toEqual(["ann"]);
  });
  it("gives a user's capabilities with the roles giving them", () => {
    expect(Object.fromEntries(userCapabilities(c, ann))).toEqual({ edit_user: ["ops"], search: ["ops"] });
  });
});
