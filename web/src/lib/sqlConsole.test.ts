import { describe, expect, it } from "vitest";
import { chartSpec } from "../components/SqlChart";
import type { Table } from "./sql";
import { EXAMPLES } from "./sql";
import { explainError, formatSql, jsonPaths, suggestions, tokenize, wordAt } from "./sqlEditor";
import { EXAMPLE_INFO } from "./sqlExamples";
import * as store from "./sqlStore";

const tables: Table[] = [
  { name: "entities", doc: "", columns: [{ name: "id", type: "TEXT" }, { name: "type", type: "TEXT" }, { name: "last_used", type: "TEXT" }, { name: "settings", type: "TEXT" }], rows: [[], []] },
  { name: "edges", doc: "", columns: [{ name: "from_id", type: "TEXT" }, { name: "to_id", type: "TEXT" }], rows: [] },
] as unknown as Table[];

describe("editor helpers", () => {
  it("tokenizes keywords, strings, tables and columns, keeping every character", () => {
    const sql = "SELECT type, count(*) FROM entities WHERE type = 'index' -- note";
    const tokens = tokenize(sql, tables);
    expect(tokens.map((t) => t.text).join("")).toBe(sql);
    const kind = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect([kind("SELECT"), kind("count"), kind("entities"), kind("type"), kind("'index'"), kind("-- note")])
      .toEqual(["keyword", "function", "table", "column", "string", "comment"]);
  });
  it("formats clauses on their own lines, leaving strings alone", () => {
    expect(formatSql("select type from entities where type = 'a where b' and disabled = 0 order by type"))
      .toBe("SELECT type\nFROM entities\nWHERE type = 'a where b'\n  AND disabled = 0\nORDER BY type;");
  });
  it("suggests tables after FROM and the query's columns first", () => {
    expect(suggestions("SELECT * FROM ed", 16, tables).map((s) => s.text)).toEqual(["edges"]);
    const sql = "SELECT la FROM entities";
    expect(suggestions(sql, 9, tables)[0]).toMatchObject({ text: "last_used", kind: "column", detail: "entities" });
    expect(wordAt("SELECT typ", 10)).toEqual([7, 10, "typ"]);
    // A complete upper-case keyword is not completed ("DESC" is not "description").
    expect(suggestions("SELECT * FROM entities ORDER BY id DESC", 39, tables)).toEqual([]);
  });
  it("explains errors with a position and a close name", () => {
    const sql = "SELECT lastused\nFROM entities";
    expect(explainError("no such column: lastused", sql, tables)).toEqual({
      message: "no such column: lastused", line: 1, column: 8, suggestion: "last_used",
    });
    expect(explainError("no such table: entitys", "SELECT * FROM entitys", tables).suggestion).toBe("entities");
    expect(explainError("something else", "x", tables)).toEqual({ message: "something else" });
  });
  it("finds the JSON paths a query reads from settings", () => {
    expect(jsonPaths("SELECT json_extract(settings, '$.a.b'), json_extract(e.settings,'$.c') FROM entities e")).toEqual(["$.a.b", "$.c"]);
  });
});

describe("chart detection", () => {
  it("draws a label and a number as bars, dates as a line, other shapes not at all", () => {
    expect(chartSpec(["type", "n"], [["index", 3], ["macro", 9]])).toMatchObject({ kind: "bar", labelColumn: 0, valueColumn: 1 });
    const line = chartSpec(["day", "events"], [["2026-11-03", 5], ["2026-11-01", 1], ["2026-11-02", 2]]);
    expect(line?.kind).toBe("line");
    expect(line?.points.map((p) => p.label)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(chartSpec(["a", "b"], [["x", "y"], ["z", "w"]])).toBeUndefined();
    expect(chartSpec(["a", "n"], [["x", 1]])).toBeUndefined();
  });
});

describe("examples, history and saved queries", () => {
  it("gives every example a group and a description", () => {
    expect(EXAMPLES.filter((x) => !EXAMPLE_INFO[x.title]).map((x) => x.title)).toEqual([]);
  });
  it("keeps history and saved queries (in memory without browser storage)", () => {
    store.clearHistory();
    store.remember("SELECT 1", 1);
    store.remember("SELECT 2", 1);
    const h = store.remember("SELECT 1", 1);
    expect(h.map((x) => x.sql)).toEqual(["SELECT 1", "SELECT 2"]); // moved to the top, not duplicated
    expect(store.save("mine", "SELECT 3")).toHaveLength(1);
    expect(store.save("mine", "SELECT 4").map((x) => x.sql)).toEqual(["SELECT 4"]);
    expect(store.unsave("mine")).toEqual([]);
  });
});
