export const entityPath = (id: string) => `/entity/${encodeURIComponent(id)}`;
export const glossaryPath = (term?: string) => (term ? `/glossary/${encodeURIComponent(term)}` : "/glossary");

export function searchPath(params: Record<string, string | string[] | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const value of Array.isArray(v) ? v : [v]) if (value) qs.append(k, value);
  }
  const s = qs.toString();
  return s ? `/search?${s}` : "/search";
}
