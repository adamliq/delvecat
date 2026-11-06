import MiniSearch from "minisearch";
import type { Entity } from "../generated/catalog";

interface Doc {
  id: string;
  name: string;
  displayName: string;
  description: string;
  app: string;
  owner: string;
  tags: string;
  body: string;
  type: string;
  product: string;
}

function toDoc(e: Entity): Doc {
  const p = (e.properties ?? {}) as Record<string, unknown>;
  const body = [p.search, p.definition].filter((v) => typeof v === "string").join(" ");
  return {
    id: e.id,
    name: e.name,
    displayName: e.displayName ?? "",
    description: e.description ?? "",
    app: e.app ?? "",
    owner: e.owner ?? "",
    tags: [...(e.tags ?? []), ...(e.classifications ?? []), ...(e.glossaryTerms ?? [])].join(" "),
    body,
    type: e.type,
    product: e.product,
  };
}

export interface Filters {
  type?: string;
  product?: string;
  app?: string;
}

export class EntitySearch {
  private readonly index: MiniSearch<Doc>;

  constructor(private readonly entities: Entity[]) {
    this.index = new MiniSearch<Doc>({
      fields: ["name", "displayName", "description", "app", "owner", "tags", "body"],
      storeFields: ["id"],
      // SPL and Splunk names use _, -, :, ., / and backticks as separators.
      tokenize: (text) => text.split(/[\s_\-:./`|=,()[\]"'*]+/).filter(Boolean),
      searchOptions: {
        boost: { name: 4, displayName: 3, tags: 2, description: 1.5 },
        prefix: true,
        fuzzy: (term) => (term.length > 4 ? 0.2 : false),
        combineWith: "AND",
      },
    });
    this.index.addAll(entities.map(toDoc));
  }

  search(query: string, filters: Filters = {}): Entity[] {
    const match = (e: Entity) =>
      (!filters.type || e.type === filters.type) &&
      (!filters.product || e.product === filters.product) &&
      (!filters.app || e.app === filters.app);
    const q = query.trim();
    if (!q) {
      return this.entities.filter(match).sort((a, b) => a.name.localeCompare(b.name));
    }
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    return this.index
      .search(q)
      .map((r) => byId.get(r.id as string)!)
      .filter((e) => e && match(e));
  }
}
