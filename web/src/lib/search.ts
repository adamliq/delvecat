import { useEffect, useState } from "react";
import MiniSearch from "minisearch";
import type { Entity } from "../generated/catalog";
import { effectiveDescription } from "./annotate";
import { dataModelColumns } from "./dataModels";
import { lookupColumns } from "./lookups";

/** Field names an object holds: a lookup's or collection's, or a data model's. */
const columnsOf = (e: Entity): string[] => (e.type === "dataModel" ? dataModelColumns(e) : lookupColumns(e));

/** Facets offered on the search page; each maps an entity to zero or more values. */
export const FACETS = {
  type: (e: Entity) => [e.type],
  product: (e: Entity) => [e.product],
  instance: (e: Entity) => [e.instance],
  app: (e: Entity) => (e.app ? [e.app] : []),
  domain: (e: Entity) => (e.annotations?.domain ? [e.annotations.domain] : []),
  dataProduct: (e: Entity) => e.annotations?.dataProducts ?? [],
  owner: (e: Entity) => e.annotations?.owners ?? [],
  tag: (e: Entity) => e.annotations?.tags ?? [],
  classification: (e: Entity) => e.annotations?.classifications ?? [],
  term: (e: Entity) => e.annotations?.glossaryTerms ?? [],
  sharing: (e: Entity) => (e.sharing ? [e.sharing] : []),
  status: (e: Entity) => [e.disabled ? "disabled" : "enabled"],
  documented: (e: Entity) => [effectiveDescription(e) ? "yes" : "no"],
  health: (e: Entity) => (e.health ? [e.health.status] : []),
  sensitivity: (e: Entity) => {
    const cs = ((e.governance as { classifications?: { sensitive: boolean; derived: boolean }[] } | undefined)?.classifications ?? []).filter((c) => c.sensitive);
    if (!cs.length) return [];
    return [cs.some((c) => !c.derived) ? "sensitive" : "sensitive (derived)"];
  },
  command: (e: Entity) => e.lineage?.commands ?? [],
  runFrom: (e: Entity) => (e.type === "adhocSearch" ? ((e.properties as { runFrom?: string[] } | undefined)?.runFrom ?? []) : []),
  inputType: (e: Entity) => {
    const k = e.type === "input" ? (e.properties as { kind?: string } | undefined)?.kind : undefined;
    return k ? [k] : [];
  },
  microsoftService: (e: Entity) => {
    const s = (e.properties as { microsoft?: { service?: string | null } } | undefined)?.microsoft?.service;
    return s ? [s] : [];
  },
  microsoftAddOn: (e: Entity) => {
    const a = (e.properties as { microsoft?: { addOn?: string | null } } | undefined)?.microsoft?.addOn;
    return a ? [a] : [];
  },
  usage: (e: Entity) => (e.usage?.unused ? [e.usage.builtin ? "unused (built-in)" : "unused"] : []),
  missing: (e: Entity) => e.annotations?.missingProperties ?? [],
  quality: (e: Entity) => (!e.quality ? [] : e.quality.failed ? ["failing checks"] : ["all checks passing"]),
  issue: (e: Entity) => [
    ...(e.lineage?.unresolved?.length ? ["broken reference"] : []),
    ...(e.lineage?.implicitIndex ? ["no index specified"] : []),
    ...(e.lineage?.warnings?.some((w) => w.includes("could not parse")) ? ["unparseable"] : []),
  ],
} satisfies Record<string, (e: Entity) => string[]>;

/** Built-in facets plus any added per bundle (structured properties use "p.<id>"). */
/** Settings that ship with Splunk (time ranges, chart types, segmenters...): many, rarely
 * interesting, so Browse leaves them out unless asked. */
export const SETTING_TYPES = new Set(["timeRange", "visualization", "segmenter", "multikvTable", "fieldDefinition", "navMenu", "capability"]);
export const isBuiltinSetting = (e: Entity) =>
  SETTING_TYPES.has(e.type) && (e.properties as { builtin?: boolean } | undefined)?.builtin === true;

export type Facet = string;
export const FACET_NAMES = Object.keys(FACETS) as Facet[];
export type Filters = Partial<Record<Facet, string[]>>;
export type FacetFn = (e: Entity) => string[];
export type Sort = "relevance" | "name" | "type" | "updated";

interface Doc {
  id: string;
  name: string;
  displayName: string;
  description: string;
  app: string;
  owner: string;
  tags: string;
  body: string;
  values: string;
  /** Field names of a lookup, KV Store collection or data model. */
  columns: string;
}

// Property keys already indexed (as body) or not worth searching.
const VALUE_SKIP = new Set(["search", "definition", "expression", "searches", "alertRecipients", "defaultRecipients", "sender", "observed", "datasets", "fields"]);
const MAX_VALUES = 60;
const DATE = /^\d{4}-\d{2}-\d{2}[T ]/;

/** Short text values of an object's properties (tenant ids, buckets, servers, Event Hub
 * names...), so a value finds the objects that hold it. Long text and dates are left out. */
/** A value and its parts worth looking up whole: "10.9.0.1:9997" -> also "10.9.0.1";
 * "s3://acme-lake/raw" -> also "acme-lake". Lower-cased. */
export function valueKeys(value: string): string[] {
  const v = value.toLowerCase();
  const out = [v];
  const noScheme = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (noScheme !== v) out.push(noScheme);
  const host = noScheme.split("/")[0];
  if (host && host !== noScheme) out.push(host);
  const hostOnly = host.replace(/:\d+$/, "");
  if (hostOnly && hostOnly !== host) out.push(hostOnly);
  return out;
}

export function propertyValues(props: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_VALUES || depth > 5 || props === null || props === undefined) return out;
  if (typeof props === "string") {
    if (props.length >= 2 && props.length <= 200 && !DATE.test(props)) out.push(props);
  } else if (Array.isArray(props)) {
    for (const v of props) propertyValues(v, out, depth + 1);
  } else if (typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (!VALUE_SKIP.has(k)) propertyValues(v, out, depth + 1);
    }
  }
  return out;
}

function toDoc(e: Entity): Doc {
  const p = (e.properties ?? {}) as Record<string, unknown>;
  const a = e.annotations ?? {};
  const queries = Array.isArray(p.searches) ? (p.searches as { query?: string; ref?: string }[]).flatMap((s) => [s.query, s.ref]) : [];
  // Email alert recipients and senders, so an address finds the alerts that write to it.
  const rec = { ...((p.defaultRecipients ?? {}) as object), ...((p.alertRecipients ?? {}) as object) };
  const addresses = Object.values(rec as Record<string, unknown>).flat().concat(p.sender ?? []);
  const body = [p.search, p.definition, p.expression, ...queries, ...addresses]
    .filter((v) => typeof v === "string")
    .join(" ");
  return {
    id: e.id,
    name: e.name,
    displayName: e.displayName ?? "",
    description: [a.description, e.description].filter(Boolean).join(" "),
    app: e.app ?? "",
    owner: [e.owner, ...(a.owners ?? [])].filter(Boolean).join(" "),
    tags: [...(a.tags ?? []), ...(a.classifications ?? []), ...(a.glossaryTerms ?? [])].join(" "),
    body,
    values: [...new Set(propertyValues(p))].join(" "),
    columns: columnsOf(e).join(" "),
  };
}

/** Objects whose name (or display name) is the query come first, then those whose name
 * starts with it, then the rest in their order: someone typing "main" wants the index
 * called main before the inputs that mention it. Stable within each group. */
export function byName(query: string, list: Entity[]): Entity[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const rank = (e: Entity) => {
    const names = [e.name, e.displayName].filter((n): n is string => !!n).map((n) => n.toLowerCase());
    return names.some((n) => n === q) ? 0 : names.some((n) => n.startsWith(q)) ? 1 : 2;
  };
  const groups: Entity[][] = [[], [], []];
  for (const e of list) groups[rank(e)].push(e);
  return groups.flat();
}

/** Why an object matched: the words found and the fields they were found in. */
export interface Match {
  terms: string[];
  fields: string[];
}

export interface SearchResult {
  results: Entity[];
  /** Per result id, why it matched (only for a text query). */
  matches: Map<string, Match>;
  /** For each facet: value → count, computed with every *other* active facet applied. */
  facets: Record<Facet, Map<string, number>>;
  /** True while the word index is still being built: only names, apps and descriptions
   * were matched (the page shows that, and searches again when the index is ready). */
  partial?: boolean;
}

/** Objects added to the word index per step when it is built in the background: small
 * batches while the browser is idle, or steps with pauses where idle callbacks are missing. */
const INDEX_BATCH = 250;
const INDEX_STEP = 1000;

export class EntitySearch {
  private readonly index: MiniSearch<Doc>;
  /** How many objects are in the word index (and the value map) so far. */
  private indexed = 0;
  private background: Promise<void> | null = null;
  private readonly byId: Map<string, Entity>;
  /** Whole values (and their host:port / URL parts), lower-cased, to the objects holding them. */
  private readonly exact = new Map<string, string[]>();

  readonly facets: Record<Facet, FacetFn>;
  readonly facetNames: Facet[];

  constructor(private readonly entities: Entity[], extraFacets: Record<Facet, FacetFn> = {}) {
    this.facets = { ...FACETS, ...extraFacets };
    this.facetNames = Object.keys(this.facets);
    this.byId = new Map(entities.map((e) => [e.id, e]));
    this.index = new MiniSearch<Doc>({
      fields: ["name", "displayName", "description", "app", "owner", "tags", "body", "values", "columns"],
      storeFields: ["id"],
      // SPL and Splunk names use _, -, :, ., / and backticks as separators.
      tokenize: (text) => text.split(/[\s_\-:./`|=,()[\]"'*@]+/).filter(Boolean),
      searchOptions: {
        boost: { name: 4, displayName: 3, tags: 2, columns: 2, description: 1.5, values: 0.5 },
        prefix: true,
        fuzzy: (term) => (term.length > 4 ? 0.2 : false),
        combineWith: "AND",
      },
    });
  }

  /** Index objects up to ``end`` (word index and whole values). */
  private indexTo(end: number) {
    const slice = this.entities.slice(this.indexed, end);
    this.index.addAll(slice.map(toDoc));
    for (const e of slice) {
      for (const v of new Set(propertyValues(e.properties ?? {}).flatMap(valueKeys))) {
        const ids = this.exact.get(v);
        if (!ids) this.exact.set(v, [e.id]);
        else if (ids[ids.length - 1] !== e.id) ids.push(e.id);
      }
    }
    this.indexed = end;
  }

  /** True once every object is in the word index. */
  get ready(): boolean {
    return this.indexed >= this.entities.length;
  }

  /**
   * Build the word index a step at a time, letting the page draw and respond in between
   * (large catalogs: seconds of work). Text searches made before it finishes complete the
   * rest at once, so their results are never partial. Without this, the index is built on
   * the first text search.
   */
  indexInBackground(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.background) return this.background;
    return (this.background = new Promise((resolve) => {
      // Index only while the browser is idle, a small batch at a time, so clicks, typing
      // and drawing always come first (without idle callbacks: small steps with pauses).
      const idle = (globalThis as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
      const step = (deadline?: { timeRemaining(): number }) => {
        do {
          if (this.ready) return resolve();
          this.indexTo(Math.min(this.entities.length, this.indexed + (deadline ? INDEX_BATCH : INDEX_STEP)));
        } while (deadline && deadline.timeRemaining() > 8);
        if (idle) idle(step, { timeout: 1000 });
        else setTimeout(step, 10);
      };
      if (idle) idle(step, { timeout: 1000 });
      else setTimeout(step, 10);
    }));
  }

  /** Resolves when the word index is complete. */
  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : this.indexInBackground();
  }

  /** While the background index is incomplete: every word must appear in the name, display
   * name, app or description (no waiting for the index). */
  private quickMatch(q: string): { list: Entity[]; matches: Map<string, Match> } {
    const words = q.toLowerCase().split(/[\s_\-:./`|=,()[\]"'*@]+/).filter(Boolean);
    const matches = new Map<string, Match>();
    const list = this.entities.filter((e) => {
      const name = `${e.name} ${e.displayName ?? ""}`.toLowerCase();
      const rest = `${e.app ?? ""} ${e.description ?? ""}`.toLowerCase();
      if (!words.every((w) => name.includes(w) || rest.includes(w))) return false;
      matches.set(e.id, { terms: words, fields: words.some((w) => name.includes(w)) ? ["name"] : ["description"] });
      return true;
    });
    return { list: byName(q, list), matches };
  }

  private matching(query: string): { list: Entity[]; matches: Map<string, Match>; partial?: boolean } {
    const q = query.trim();
    const matches = new Map<string, Match>();
    if (!q) return { list: this.entities, matches };
    if (!this.ready && this.background) return { ...this.quickMatch(q), partial: true };
    if (!this.ready) this.indexTo(this.entities.length);
    // A query that is exactly a value an object holds (an IP, a tenant id, a bucket) ranks
    // those objects first: word search splits such values into pieces.
    const exact = (this.exact.get(q.toLowerCase()) ?? []).map((id) => this.byId.get(id)!).filter(Boolean);
    for (const e of exact) matches.set(e.id, { terms: [q], fields: ["values"] });
    const hits = this.index.search(q);
    for (const r of hits) {
      if (matches.has(r.id as string)) continue;
      const fields = [...new Set(Object.values(r.match).flat())];
      matches.set(r.id as string, { terms: Object.keys(r.match), fields });
    }
    const words = byName(q, hits.map((r) => this.byId.get(r.id as string)!).filter(Boolean));
    if (!exact.length) return { list: words, matches };
    const seen = new Set(exact.map((e) => e.id));
    // Names still come first: "main" is the index main before the inputs that send to it.
    return { list: byName(q, [...exact, ...words.filter((e) => !seen.has(e.id))]), matches };
  }

  /** ``hide`` leaves objects out entirely (counts included), e.g. built-in settings. */
  query(query: string, filters: Filters = {}, sort: Sort = "relevance", hide?: (e: Entity) => boolean): SearchResult {
    const matched = this.matching(query);
    const base = hide ? matched.list.filter((e) => !hide(e)) : matched.list;
    const { matches } = matched;
    const active = this.facetNames.filter((f) => filters[f]?.length);
    const wanted = new Map(active.map((f) => [f, new Set(filters[f])]));
    const ok = (f: Facet, e: Entity) => {
      const want = wanted.get(f)!;
      return this.facets[f](e).some((v) => want.has(v));
    };

    // A facet's counts cover objects passing every *other* active filter. So each object
    // is checked against each active filter once: passing all, it counts for every facet;
    // failing exactly one, only for that facet; failing more, for none.
    const counts = new Map<Facet, Map<string, number>>(this.facetNames.map((f) => [f, new Map()]));
    const add = (f: Facet, e: Entity) => {
      const c = counts.get(f)!;
      const vs = this.facets[f](e);
      if (vs.length === 1) c.set(vs[0], (c.get(vs[0]) ?? 0) + 1);
      else if (vs.length > 1) for (const v of new Set(vs)) c.set(v, (c.get(v) ?? 0) + 1);
    };
    const results: Entity[] = [];
    for (const e of base) {
      let failed: Facet | null = null;
      let fails = 0;
      for (const f of active) {
        if (!ok(f, e)) {
          failed = f;
          if (++fails > 1) break;
        }
      }
      if (fails === 0) {
        results.push(e);
        for (const f of this.facetNames) add(f, e);
      } else if (fails === 1) {
        add(failed!, e);
      }
    }
    const facets = {} as Record<Facet, Map<string, number>>;
    for (const f of this.facetNames) {
      facets[f] = new Map([...counts.get(f)!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    }

    const effective = sort === "relevance" && !query.trim() ? "name" : sort;
    if (effective === "name") results.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
    if (effective === "type") results.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    if (effective === "updated") results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { results, facets, matches, ...(matched.partial ? { partial: true } : {}) };
  }

  /** Backwards-compatible single-value filtering used by simple callers. */
  search(query: string, filters: { type?: string; product?: string; app?: string } = {}): Entity[] {
    const f: Filters = {};
    for (const [k, v] of Object.entries(filters)) if (v) f[k as Facet] = [v];
    return this.query(query, f).results;
  }
}

// --- why it matched -----------------------------------------------------------------------

/** Property values with the key that holds them ("tenantId", "servers"), for match snippets. */
export function propertyPairs(props: unknown, key = "", out: [string, string][] = [], depth = 0): [string, string][] {
  if (out.length >= MAX_VALUES || depth > 5 || props === null || props === undefined) return out;
  if (typeof props === "string") {
    if (props.length >= 2 && props.length <= 200 && !DATE.test(props)) out.push([key, props]);
  } else if (Array.isArray(props)) {
    for (const v of props) propertyPairs(v, key, out, depth + 1);
  } else if (typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (!VALUE_SKIP.has(k)) propertyPairs(v, k, out, depth + 1);
    }
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  name: "name", displayName: "name", description: "description", app: "app", owner: "owner",
  tags: "tags, classifications or terms", body: "search text", values: "a property value", columns: "field",
};

export interface Snippet {
  /** Where it matched, in words. */
  where: string;
  /** The text around the match (a value, or part of the SPL); undefined for name/description. */
  text?: string;
  key?: string;
}

const lower = (s: string) => s.toLowerCase();

/** A short explanation of the match for a result row. */
export function matchSnippet(e: Entity, m: Match | undefined): Snippet | undefined {
  if (!m || !m.fields.length) return undefined;
  const fields = [...new Set(m.fields.map((f) => FIELD_WORDS[f] ?? f))];
  const terms = m.terms.map(lower);
  const has = (t: string) => terms.some((w) => lower(t).includes(w));
  // Name or description matches show in the row already (highlighted).
  if (m.fields.some((f) => f === "name" || f === "displayName" || f === "description")) return { where: fields.join(", ") };
  if (m.fields.includes("columns")) {
    const hit = columnsOf(e).filter((c) => has(c));
    if (hit.length) return { where: hit.length > 1 ? "fields" : "field", text: hit.slice(0, 5).join(", ") };
  }
  if (m.fields.includes("values")) {
    const pair = propertyPairs(e.properties ?? {}).find(([, v]) => has(v));
    if (pair) return { where: fields.join(", "), key: pair[0], text: pair[1] };
  }
  if (m.fields.includes("body")) {
    const p = (e.properties ?? {}) as Record<string, unknown>;
    const text = [p.search, p.definition, p.expression].find((v): v is string => typeof v === "string" && has(v));
    if (text) {
      const at = Math.min(...terms.map((w) => lower(text).indexOf(w)).filter((i) => i >= 0));
      const start = Math.max(0, at - 40);
      return { where: fields.join(", "), text: `${start ? "…" : ""}${text.slice(start, at + 60)}${at + 60 < text.length ? "…" : ""}` };
    }
  }
  return { where: fields.join(", ") };
}

/** Text split into [plain, matched] pieces for highlighting; matching is case-insensitive. */
export function highlightParts(text: string, terms: string[]): [string, boolean][] {
  const words = terms.map(lower).filter((w) => w.length > 1).sort((a, b) => b.length - a.length);
  if (!words.length || !text) return [[text, false]];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.split(re).filter((x) => x !== "").map((x) => [x, words.includes(lower(x))] as [string, boolean]);
}

/** Whether the word index is complete; re-renders once when it becomes so. */
export function useSearchReady(search: EntitySearch | undefined): boolean {
  const [ready, setReady] = useState(() => !search || search.ready);
  useEffect(() => {
    if (!search || search.ready) {
      setReady(true);
      return;
    }
    setReady(false);
    let live = true;
    void search.whenReady().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [search]);
  return ready;
}
