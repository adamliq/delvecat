/**
 * The SQL console's editor helpers: syntax highlighting tokens, a small formatter,
 * table/column autocomplete and readable error help. No dependencies.
 */
import type { Table } from "./sql";

export type TokenKind = "keyword" | "function" | "string" | "number" | "comment" | "table" | "column" | "punct" | "text";
export interface Token {
  kind: TokenKind;
  text: string;
}

export const KEYWORDS = new Set(
  (
    "select from where and or not null is in like glob between as on join left right inner outer cross " +
    "group by order asc desc limit offset having distinct union all except intersect with case when then " +
    "else end exists collate escape true false over partition"
  ).split(" "),
);
export const FUNCTIONS = new Set(
  (
    "count sum avg min max total group_concat coalesce ifnull nullif length lower upper substr trim " +
    "replace instr round abs date datetime julianday strftime json_extract json_each json_tree json_array " +
    "json_object json_type json_array_length cast printf iif"
  ).split(" "),
);

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_'"]+)/g;

/** Split SQL into highlightable tokens (every character belongs to one token). */
export function tokenize(sql: string, tables: Table[] = []): Token[] {
  const tableNames = new Set(tables.map((t) => t.name.toLowerCase()));
  const columnNames = new Set(tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())));
  const out: Token[] = [];
  for (const m of sql.matchAll(TOKEN)) {
    const [text, comment, str, quoted, num, word] = m;
    let kind: TokenKind = "text";
    if (comment) kind = "comment";
    else if (str) kind = "string";
    else if (quoted) kind = "column";
    else if (num) kind = "number";
    else if (word) {
      const w = word.toLowerCase();
      kind = KEYWORDS.has(w) ? "keyword" : FUNCTIONS.has(w) ? "function" : tableNames.has(w) ? "table" : columnNames.has(w) ? "column" : "text";
    } else if (m[7]) kind = "punct";
    out.push({ kind, text });
  }
  return out;
}

// --- formatting ----------------------------------------------------------------------------

const CLAUSES = [
  "select", "from", "where", "group by", "order by", "having", "limit", "union all", "union", "except", "intersect",
  "left join", "inner join", "cross join", "join", "with",
];

/** A readable layout: one clause per line, AND/OR indented, keywords upper-cased.
 * Strings and comments are left exactly as they are. */
export function formatSql(sql: string): string {
  const parts: string[] = [];
  for (const t of tokenize(sql)) {
    if (t.kind === "keyword") parts.push(t.text.toUpperCase());
    else if (t.kind === "text" && /^\s+$/.test(t.text)) parts.push(" ");
    else parts.push(t.text);
  }
  let s = parts.join("").replace(/ +/g, " ").trim();
  // Protect strings and comments from the clause breaks.
  const kept: string[] = [];
  s = s.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  for (const clause of CLAUSES) {
    const re = new RegExp(`\\s+(${clause.toUpperCase().replace(" ", "\\s+")})\\b`, "g");
    s = s.replace(re, "\n$1");
  }
  s = s.replace(/\s+\b(AND|OR)\b\s+/g, "\n  $1 ");
  s = s.replace(/,\s*(?=[A-Za-z_(])/g, (_m, offset: number) => {
    // Break select lists that are long; keep short function arguments together.
    const line = s.slice(s.lastIndexOf("\n", offset) + 1, offset);
    return line.length > 60 ? ",\n       " : ", ";
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
  return s.replace(/\s*;\s*$/, "") + ";";
}

// --- autocomplete --------------------------------------------------------------------------

export interface Suggestion {
  text: string;
  kind: "table" | "column" | "keyword" | "function";
  detail?: string;
}

/** The word being typed at the cursor: [start, end, word]. */
export function wordAt(text: string, cursor: number): [number, number, string] {
  let start = cursor;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = cursor;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  return [start, end, text.slice(start, cursor)];
}

/** Tables named in the query, so their columns are suggested first. */
function tablesInQuery(sql: string, tables: Table[]): Set<string> {
  const names = new Set(tables.map((t) => t.name.toLowerCase()));
  return new Set([...sql.toLowerCase().matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]).filter((n) => names.has(n)));
}

export function suggestions(sql: string, cursor: number, tables: Table[], max = 8): Suggestion[] {
  const [, , word] = wordAt(sql, cursor);
  if (word.length < 1) return [];
  const w = word.toLowerCase();
  const before = sql.slice(0, cursor - word.length).toLowerCase();
  const afterTableKeyword = /\b(from|join|into)\s+$/.test(before);
  const used = tablesInQuery(sql, tables);
  const out: (Suggestion & { rank: number })[] = [];
  for (const t of tables) {
    if (t.name.toLowerCase().startsWith(w)) out.push({ text: t.name, kind: "table", detail: `${t.rows.length.toLocaleString()} rows`, rank: afterTableKeyword ? 0 : 2 });
    if (afterTableKeyword) continue;
    for (const c of t.columns) {
      if (c.name.toLowerCase().startsWith(w)) {
        out.push({ text: c.name, kind: "column", detail: t.name, rank: used.has(t.name.toLowerCase()) ? 1 : 3 });
      }
    }
  }
  if (!afterTableKeyword) {
    for (const k of KEYWORDS) if (k.startsWith(w) && k !== w) out.push({ text: k.toUpperCase(), kind: "keyword", rank: 4 });
    for (const f of FUNCTIONS) if (f.startsWith(w) && f !== w) out.push({ text: f, kind: "function", rank: 4 });
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.rank - b.rank || a.text.length - b.text.length || a.text.localeCompare(b.text))
    .filter((s) => (seen.has(s.text.toLowerCase()) ? false : (seen.add(s.text.toLowerCase()), true)))
    .filter((s) => s.text.toLowerCase() !== w)
    .slice(0, max)
    .map(({ rank: _rank, ...s }) => s);
}

// --- errors --------------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function closest(name: string, candidates: string[]): string | undefined {
  const n = name.toLowerCase();
  let best: [string, number] | undefined;
  for (const c of candidates) {
    const d = levenshtein(n, c.toLowerCase());
    const contains = c.toLowerCase().includes(n) || n.includes(c.toLowerCase());
    const score = contains ? Math.min(d, 1) : d;
    if (score <= Math.max(2, Math.floor(n.length / 3)) && (!best || score < best[1])) best = [c, score];
  }
  return best?.[0];
}

export interface ErrorHelp {
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

/** SQLite's message, where in the query it is, and a close name if one exists. */
export function explainError(message: string, sql: string, tables: Table[]): ErrorHelp {
  const m = /no such (column|table|function): ([\w.]+)/i.exec(message) ?? /near "([^"]+)": syntax error/i.exec(message);
  if (!m) return { message };
  const kind = m.length === 3 ? m[1].toLowerCase() : "near";
  const name = (m.length === 3 ? m[2] : m[1]).split(".").pop()!;
  const at = sql.toLowerCase().search(new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  const pos = at >= 0 ? { line: sql.slice(0, at).split("\n").length, column: at - sql.lastIndexOf("\n", at - 1) } : {};
  let suggestion: string | undefined;
  if (kind === "column") suggestion = closest(name, [...new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))]);
  else if (kind === "table") suggestion = closest(name, tables.map((t) => t.name));
  else if (kind === "function") suggestion = closest(name, [...FUNCTIONS]);
  return { message, ...pos, suggestion };
}

/** JSON paths a query reads from settings ("$.a.b"), to check they exist in the data. */
export function jsonPaths(sql: string): string[] {
  return [...new Set([...sql.matchAll(/json_extract\s*\(\s*[\w.]*settings\s*,\s*'(\$[^']+)'\s*\)/gi)].map((m) => m[1]))];
}
