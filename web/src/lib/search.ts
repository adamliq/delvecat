import MiniSearch from "minisearch";
import type { Entity } from "../generated/catalog";
import { effectiveDescription } from "./annotate";

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
  usage: (e: Entity) => (e.usage?.unused ? [e.usage.builtin ? "unused (built-in)" : "unused"] : []),
  issue: (e: Entity) => [
    ...(e.lineage?.unresolved?.length ? ["broken reference"] : []),
    ...(e.lineage?.implicitIndex ? ["no index specified"] : []),
    ...(e.lineage?.warnings?.some((w) => w.includes("could not parse")) ? ["unparseable"] : []),
  ],
} satisfies Record<string, (e: Entity) => string[]>;

export type Facet = keyof typeof FACETS;
export const FACET_NAMES = Object.keys(FACETS) as Facet[];
export type Filters = Partial<Record<Facet, string[]>>;
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
}

function toDoc(e: Entity): Doc {
  const p = (e.properties ?? {}) as Record<string, unknown>;
  const a = e.annotations ?? {};
  const queries = Array.isArray(p.searches) ? (p.searches as { query?: string; ref?: string }[]).flatMap((s) => [s.query, s.ref]) : [];
  const body = [p.search, p.definition, p.expression, ...queries].filter((v) => typeof v === "string").join(" ");
  return {
    id: e.id,
    name: e.name,
    displayName: e.displayName ?? "",
    description: [a.description, e.description].filter(Boolean).join(" "),
    app: e.app ?? "",
    owner: [e.owner, ...(a.owners ?? [])].filter(Boolean).join(" "),
    tags: [...(a.tags ?? []), ...(a.classifications ?? []), ...(a.glossaryTerms ?? [])].join(" "),
    body,
  };
}

export interface SearchResult {
  results: Entity[];
  /** For each facet: value → count, computed with every *other* active facet applied. */
  facets: Record<Facet, Map<string, number>>;
}

export class EntitySearch {
  private readonly index: MiniSearch<Doc>;
  private readonly byId: Map<string, Entity>;

  constructor(private readonly entities: Entity[]) {
    this.byId = new Map(entities.map((e) => [e.id, e]));
    this.index = new MiniSearch<Doc>({
      fields: ["name", "displayName", "description", "app", "owner", "tags", "body"],
      storeFields: ["id"],
      // SPL and Splunk names use _, -, :, ., / and backticks as separators.
      tokenize: (text) => text.split(/[\s_\-:./`|=,()[\]"'*@]+/).filter(Boolean),
      searchOptions: {
        boost: { name: 4, displayName: 3, tags: 2, description: 1.5 },
        prefix: true,
        fuzzy: (term) => (term.length > 4 ? 0.2 : false),
        combineWith: "AND",
      },
    });
    this.index.addAll(entities.map(toDoc));
  }

  private matching(query: string): Entity[] {
    const q = query.trim();
    if (!q) return this.entities;
    return this.index.search(q).map((r) => this.byId.get(r.id as string)!).filter(Boolean);
  }

  query(query: string, filters: Filters = {}, sort: Sort = "relevance"): SearchResult {
    const base = this.matching(query);
    const active = FACET_NAMES.filter((f) => filters[f]?.length);
    const passes = (e: Entity, skip?: Facet) =>
      active.every((f) => f === skip || FACETS[f](e).some((v) => filters[f]!.includes(v)));

    const facets = {} as Record<Facet, Map<string, number>>;
    for (const f of FACET_NAMES) {
      const counts = new Map<string, number>();
      for (const e of base) {
        if (!passes(e, f)) continue;
        for (const v of new Set(FACETS[f](e))) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      facets[f] = new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    }

    const results = base.filter((e) => passes(e));
    const effective = sort === "relevance" && !query.trim() ? "name" : sort;
    if (effective === "name") results.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
    if (effective === "type") results.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    if (effective === "updated") results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { results, facets };
  }

  /** Backwards-compatible single-value filtering used by simple callers. */
  search(query: string, filters: { type?: string; product?: string; app?: string } = {}): Entity[] {
    const f: Filters = {};
    for (const [k, v] of Object.entries(filters)) if (v) f[k as Facet] = [v];
    return this.query(query, f).results;
  }
}
