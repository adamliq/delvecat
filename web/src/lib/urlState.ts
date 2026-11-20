import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export type ParamValue = string | number | boolean | undefined | null;

/**
 * Page state kept in the URL, so a filtered view can be shared, bookmarked and restored
 * with back/forward. Empty, false and null values are removed; true is stored as "1".
 * `reset` clears every other key first.
 */
export function useUrlState(): [URLSearchParams, (patch: Record<string, ParamValue>, reset?: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const update = useCallback(
    (patch: Record<string, ParamValue>, reset = false) =>
      setParams((p) => {
        const next = reset ? new URLSearchParams() : new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null || v === false || v === "") next.delete(k);
          else next.set(k, v === true ? "1" : String(v));
        }
        return next;
      }, { replace: true }),
    [setParams],
  );
  return [params, update];
}

export const flag = (params: URLSearchParams, key: string): boolean => params.get(key) === "1";
