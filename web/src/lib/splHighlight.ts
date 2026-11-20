/**
 * A light SPL tokenizer for display: commands (after a pipe or at the start), keywords,
 * strings, macros, comments, and the object a word refers to (macro, lookup, index, data
 * model, saved search) so the page can link it. Not a parser: SPL text stays exactly as is.
 */
export type SplKind = "command" | "keyword" | "string" | "macro" | "comment" | "field" | "text";

export interface SplToken {
  kind: SplKind;
  text: string;
  /** An object this token names. */
  ref?: { type: string; name: string };
}

const KEYWORDS = new Set(["and", "or", "not", "by", "as", "over", "where", "output", "outputnew", "in", "like"]);
const LOOKUP_COMMANDS = new Set(["lookup", "inputlookup", "outputlookup"]);

// A macro (`name(args)`), a block comment (```...```), a string, a key=value name, a pipe, a word.
const TOKEN = /(```[\s\S]*?```)|(`[^`]*`)|("(?:[^"\\]|\\.)*"?)|(\|)|([A-Za-z_][\w.:-]*)(?==)|([A-Za-z_][\w.:*-]*)|(\s+)|([^\s`"|A-Za-z_]+)/g;

/** The macro a `call(args)` names, as Splunk stores it: name(argument count). */
export function macroName(call: string): string {
  const m = /^([^(]+)\((.*)\)$/s.exec(call.trim());
  if (!m) return call.trim();
  const args = m[2].trim() ? splitArgs(m[2]).length : 0;
  return args ? `${m[1].trim()}(${args})` : m[1].trim();
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = "";
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === "(") depth++;
    if (!quote && ch === ")") depth--;
    if (!quote && depth === 0 && ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function splTokens(spl: string): SplToken[] {
  const out: SplToken[] = [];
  let expectCommand = true; // at the start, or right after a pipe
  let lastCommand = "";
  let lastField = "";
  let lookupArg = false;
  for (const m of spl.matchAll(TOKEN)) {
    const [text, comment, macro, str, pipe, field, word, space] = m;
    if (space) { out.push({ kind: "text", text }); continue; }
    if (comment) { out.push({ kind: "comment", text }); continue; }
    if (macro) {
      out.push({ kind: "macro", text, ref: { type: "macro", name: macroName(text.slice(1, -1)) } });
      expectCommand = false;
      continue;
    }
    if (pipe) { out.push({ kind: "command", text }); expectCommand = true; lookupArg = false; continue; }
    if (str) { out.push({ kind: "string", text, ...refFor(lastField, str.replace(/^"|"$/g, "")) }); lastField = ""; continue; }
    if (field) {
      out.push({ kind: "field", text });
      lastField = field.toLowerCase();
      expectCommand = false;
      continue;
    }
    if (word) {
      const w = word.toLowerCase();
      if (expectCommand && !lastField) {
        out.push({ kind: "command", text });
        lastCommand = w;
        expectCommand = false;
        lookupArg = LOOKUP_COMMANDS.has(w);
        continue;
      }
      if (KEYWORDS.has(w)) { out.push({ kind: "keyword", text }); continue; }
      if (lookupArg) {
        out.push({ kind: "text", text, ref: { type: "lookup", name: word } });
        lookupArg = false;
        continue;
      }
      if (lastCommand === "savedsearch" && !lastField) {
        out.push({ kind: "text", text, ref: { type: "savedSearch", name: word } });
        continue;
      }
      if (lastField) {
        out.push({ kind: "text", text, ...refFor(lastField, word) });
        lastField = "";
        continue;
      }
      out.push({ kind: "text", text });
      continue;
    }
    // punctuation: "=" keeps the field it follows
    out.push({ kind: "text", text });
    if (!text.includes("=")) lastField = "";
  }
  return out;
}

function refFor(field: string, value: string): Pick<SplToken, "ref"> | Record<string, never> {
  if (!value || value.includes("*")) return {};
  if (field === "index") return { ref: { type: "index", name: value } };
  if (field === "sourcetype") return { ref: { type: "sourcetype", name: value } };
  if (field === "eventtype") return { ref: { type: "eventtype", name: value } };
  if (field === "datamodel") return { ref: { type: "dataModel", name: value.split(".")[0] } };
  return {};
}
