import type { AnnotationSource, Entity } from "../generated/catalog";

/** Annotated description first, falling back to the one from Splunk. */
export function effectiveDescription(e: Entity): string | undefined {
  return e.annotations?.description || e.description || undefined;
}

/** Owners from annotations; the Splunk owner of a shared object is not a business owner. */
export function owners(e: Entity): string[] {
  return e.annotations?.owners ?? [];
}

function yamlString(s: string): string {
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

/** A ready-to-edit annotation entry for an entity. */
export function annotationSnippet(e: Entity): string {
  const a = e.annotations ?? {};
  const list = (xs?: string[]) => `[${(xs ?? []).map(yamlString).join(", ")}]`;
  return [
    "annotations:",
    `  - id: ${yamlString(e.id)}`,
    `    description: ${yamlString(a.description ?? "")}`,
    `    domain: ${yamlString(a.domain ?? "")}`,
    `    owners: ${list(a.owners)}`,
    `    tags: ${list(a.tags)}`,
    `    classifications: ${list(a.classifications)}`,
    `    glossaryTerms: ${list(a.glossaryTerms)}`,
    // JSON objects are valid YAML flow mappings; missing required values start empty.
    `    properties: ${JSON.stringify({
      ...Object.fromEntries((a.missingProperties ?? []).map((p) => [p, ""])),
      ...(a.properties ?? {}),
    }).replace(/","/g, '", "').replace(/,"/g, ', "').replace(/":/g, '": ')}`,
    "",
  ].join("\n");
}

/** Stable short hash so suggested file names never collide. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

export function suggestedFileName(e: Entity): string {
  const slug = e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "entity";
  return `${e.instance}/${e.type}-${slug}-${shortHash(e.id)}.yaml`;
}

/** Split "annotations/acme/web.yaml:12" into file and line. */
export function parseSource(source: string): { file: string; line?: number } {
  const m = /^(.*?)(?::(\d+))?$/.exec(source)!;
  return { file: m[1], line: m[2] ? Number(m[2]) : undefined };
}

export interface EditLinks {
  /** Existing annotation files that touch this entity. */
  sources: { label: string; view: string; edit: string }[];
  /** Pre-filled "new file" page for a new, entity-specific annotation. */
  create: string;
  /** The entity's own (id) entry, when it has one: edit this rather than adding a file. */
  primary?: { label: string; view: string; edit: string };
}

export function editLinks(e: Entity, src: AnnotationSource): EditLinks {
  const repo = src.repoUrl.replace(/\/$/, "");
  const branch = encodeURIComponent(src.branch);
  const files = [...new Set(e.annotations?.sources ?? [])];
  const sources = files.map((s) => {
    const { file, line } = parseSource(s);
    return {
      label: s,
      view: `${repo}/blob/${branch}/${file}${line ? `#L${line}` : ""}`,
      edit: `${repo}/edit/${branch}/${file}`,
    };
  });
  const params = new URLSearchParams({
    filename: `${src.path}/${suggestedFileName(e)}`,
    value: annotationSnippet(e),
  });
  const primary = sources.find((s) => s.label === e.annotations?.primarySource);
  return { sources, primary, create: `${repo}/new/${branch}?${params.toString()}` };
}
