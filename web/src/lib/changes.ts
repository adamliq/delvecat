import type { Catalog } from "./catalog";

export type DiffRow = { key: string; before?: unknown; after?: unknown };
export interface BuildChanges {
  generatedAt: string;
  previousGeneratedAt: string;
  added: string[];
  modified: string[];
  removed: { id: string; type: string; name: string }[];
  details: Record<string, DiffRow[]>;
}

/** The changes of this build and the earlier ones kept with it, newest first. */
export function buildChanges(catalog: Catalog): BuildChanges[] {
  const b = catalog.bundle;
  const norm = (c: NonNullable<typeof b.changes>, at: string): BuildChanges => ({
    generatedAt: at,
    previousGeneratedAt: c.previousGeneratedAt,
    added: c.added,
    modified: c.modified,
    removed: c.removed as BuildChanges["removed"],
    details: (c.details ?? {}) as Record<string, DiffRow[]>,
  });
  if (!b.changes) return [];
  return [
    norm(b.changes, b.generatedAt),
    ...(b.changeHistory ?? []).filter((c) => c.generatedAt).map((c) => norm(c, c.generatedAt as string)),
  ];
}

export interface ObjectChange {
  generatedAt: string;
  kind: "added" | "modified";
  rows: DiffRow[];
}

/** When this object was added or changed, over the builds kept, newest first. */
export function objectHistory(catalog: Catalog, id: string): ObjectChange[] {
  const out: ObjectChange[] = [];
  for (const c of buildChanges(catalog)) {
    if (c.modified.includes(id)) out.push({ generatedAt: c.generatedAt, kind: "modified", rows: c.details[id] ?? [] });
    else if (c.added.includes(id)) out.push({ generatedAt: c.generatedAt, kind: "added", rows: [] });
  }
  return out;
}
