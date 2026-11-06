export const entityPath = (id: string) => `/entity/${encodeURIComponent(id)}`;

export function searchPath(params: Record<string, string | undefined>) {
  const qs = new URLSearchParams(
    Object.entries(params).filter((kv): kv is [string, string] => Boolean(kv[1])),
  ).toString();
  return qs ? `/search?${qs}` : "/search";
}
