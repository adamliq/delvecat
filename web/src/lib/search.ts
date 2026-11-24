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
export const SETTING_TYPES = new Set(["timeRange", "visualization", "segmenter", "multikvTable", "fieldDefinition", "navMenu"]);
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
}

export class EntitySearch {
  private readonly index: MiniSearch<Doc>;
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
    this.index.addAll(entities.map(toDoc));
    for (const e of entities) {
      for (const v of new Set(propertyValues(e.properties ?? {}).flatMap(valueKeys))) {
        const ids = this.exact.get(v);
        if (!ids) this.exact.set(v, [e.id]);
        else if (ids[ids.length - 1] !== e.id) ids.push(e.id);
      }
    }
  }

  private matching(query: string): { list: Entity[]; matches: Map<string, Match> } {
    const q = query.trim();
    const matches = new Map<string, Match>();
    if (!q) return { list: this.entities, matches };
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
    const words = hits.map((r) => this.byId.get(r.id as string)!).filter(Boolean);
    if (!exact.length) return { list: words, matches };
    const seen = new Set(exact.map((e) => e.id));
    return { list: [...exact, ...words.filter((e) => !seen.has(e.id))], matches };
  }

  /** ``hide`` leaves objects out entirely (counts included), e.g. built-in settings. */
  query(query: string, filters: Filters = {}, sort: Sort = "relevance", hide?: (e: Entity) => boolean): SearchResult {
    const matched = this.matching(query);
    const base = hide ? matched.list.filter((e) => !hide(e)) : matched.list;
    const { matches } = matched;
    const active = this.facetNames.filter((f) => filters[f]?.length);
    const passes = (e: Entity, skip?: Facet) =>
      active.every((f) => f === skip || this.facets[f](e).some((v) => filters[f]!.includes(v)));

    const facets = {} as Record<Facet, Map<string, number>>;
    for (const f of this.facetNames) {
      const counts = new Map<string, number>();
      for (const e of base) {
        if (!passes(e, f)) continue;
        for (const v of new Set(this.facets[f](e))) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      facets[f] = new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    }

    const results = base.filter((e) => passes(e));
    const effective = sort === "relevance" && !query.trim() ? "name" : sort;
    if (effective === "name") results.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
    if (effective === "type") results.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    if (effective === "updated") results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { results, facets, matches };
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
