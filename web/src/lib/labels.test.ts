import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { typeGroup } from "./labels";

describe("type groups", () => {
  it("puts every object type in a group", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../schemas/catalog.schema.json", import.meta.url), "utf-8"));
    const types: string[] = schema.$defs.EntityType.enum;
    expect(types.filter((t) => typeGroup(t) === "Other")).toEqual([]);
    expect(typeGroup("authToken")).toBe("Platform and access");
    expect(typeGroup("somethingNew")).toBe("Other");
  });
});
