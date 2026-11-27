/**
 * JSON too large for one string. Browsers cap a string at about 512 million characters,
 * and a catalog of a million objects is about 700 MB of JSON, so `JSON.parse(text)` cannot
 * even be given it. This reads the UTF-8 bytes instead: a value that fits under `limit`
 * bytes is parsed as usual; a larger object is read member by member and a larger list a
 * few MB of items at a time, so no single string comes near the cap.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJ = 0x7b;
const CLOSE_OBJ = 0x7d;
const OPEN_ARR = 0x5b;
const CLOSE_ARR = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

/** Values up to this size are parsed in one go (bytes; well under the string cap). */
export const WHOLE_LIMIT = 256 * 1048576;
/** List items are parsed in groups of about this many bytes. */
const BATCH = 8 * 1048576;

const decoder = new TextDecoder();

export class TooLargeJson extends Error {}

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function skipSpace(b: Uint8Array, i: number, end: number): number {
  while (i < end && isSpace(b[i])) i++;
  return i;
}

/** The index just past the string that starts (with its quote) at i. */
function stringEnd(b: Uint8Array, i: number, end: number): number {
  for (i++; i < end; i++) {
    const c = b[i];
    if (c === BACKSLASH) i++;
    else if (c === QUOTE) return i + 1;
  }
  throw new SyntaxError("Unterminated string in JSON");
}

/** The index just past the value that starts at i. */
function valueEnd(b: Uint8Array, i: number, end: number): number {
  const c = b[i];
  if (c === QUOTE) return stringEnd(b, i, end);
  if (c === OPEN_OBJ || c === OPEN_ARR) {
    let depth = 0;
    for (; i < end; i++) {
      const x = b[i];
      if (x === QUOTE) i = stringEnd(b, i, end) - 1;
      else if (x === OPEN_OBJ || x === OPEN_ARR) depth++;
      else if ((x === CLOSE_OBJ || x === CLOSE_ARR) && --depth === 0) return i + 1;
    }
    throw new SyntaxError("Unterminated object or list in JSON");
  }
  while (i < end && b[i] !== COMMA && b[i] !== CLOSE_OBJ && b[i] !== CLOSE_ARR && !isSpace(b[i])) i++;
  return i;
}

const parseSlice = (b: Uint8Array, start: number, end: number) => JSON.parse(decoder.decode(b.subarray(start, end)));

function expect(b: Uint8Array, i: number, c: number) {
  if (b[i] !== c) throw new SyntaxError(`Expected '${String.fromCharCode(c)}' at byte ${i} in JSON`);
}

function parseRange(b: Uint8Array, start: number, end: number, limit: number): unknown {
  if (end - start <= limit) return parseSlice(b, start, end);
  if (b[start] === OPEN_OBJ) {
    const out: Record<string, unknown> = {};
    let i = skipSpace(b, start + 1, end);
    if (b[i] === CLOSE_OBJ) return out;
    for (;;) {
      expect(b, i, QUOTE);
      const keyEnd = stringEnd(b, i, end);
      const key = parseSlice(b, i, keyEnd) as string;
      i = skipSpace(b, keyEnd, end);
      expect(b, i, COLON);
      i = skipSpace(b, i + 1, end);
      const vEnd = valueEnd(b, i, end);
      out[key] = parseRange(b, i, vEnd, limit);
      i = skipSpace(b, vEnd, end);
      if (b[i] === CLOSE_OBJ) return out;
      expect(b, i, COMMA);
      i = skipSpace(b, i + 1, end);
    }
  }
  if (b[start] === OPEN_ARR) {
    const out: unknown[] = [];
    const batch = Math.min(BATCH, limit);
    let from = -1; // the group of small items not parsed yet: bytes [from, last)
    let last = -1;
    const flush = () => {
      if (from < 0) return;
      // a loop, not push(...items): hundreds of thousands of items overflow the stack
      for (const item of JSON.parse("[" + decoder.decode(b.subarray(from, last)) + "]") as unknown[]) out.push(item);
      from = last = -1;
    };
    let i = skipSpace(b, start + 1, end);
    if (b[i] === CLOSE_ARR) return out;
    for (;;) {
      const vEnd = valueEnd(b, i, end);
      if (vEnd - i > batch) {
        flush();
        out.push(parseRange(b, i, vEnd, limit));
      } else {
        if (from < 0) from = i;
        last = vEnd;
        if (last - from >= batch) flush();
      }
      i = skipSpace(b, vEnd, end);
      if (b[i] === CLOSE_ARR) {
        flush();
        return out;
      }
      expect(b, i, COMMA);
      i = skipSpace(b, i + 1, end);
    }
  }
  throw new TooLargeJson("A single value in the JSON is too large to read.");
}

/** Parse JSON given as UTF-8 bytes, however large. */
export function parseJsonBytes(bytes: Uint8Array, limit = WHOLE_LIMIT): unknown {
  let start = 0;
  let end = bytes.length;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3; // BOM
  start = skipSpace(bytes, start, end);
  while (end > start && isSpace(bytes[end - 1])) end--;
  if (end - start <= limit) return parseSlice(bytes, start, end);
  const vEnd = valueEnd(bytes, start, end);
  if (vEnd !== end) throw new SyntaxError("Unexpected data after JSON");
  return parseRange(bytes, start, end, limit);
}
