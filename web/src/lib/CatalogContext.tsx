import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogBundle } from "../generated/catalog";
import { Catalog, defaultBundleUrl, fetchBundle, openLocalFiles } from "./catalog";
import { riskMap, type Risk } from "./risk";
import { IN_SPLUNK, fetchSplunkCatalog } from "./splunkSource";
import { EntitySearch } from "./search";
import { propertyDefs, propertyFacets } from "./structured";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog; search: EntitySearch; origin: string };

interface Ctx {
  state: State;
  openFiles: (files: File[]) => Promise<void>;
  /** Load the catalog again (after a build in the Splunk app). */
  reload: () => Promise<void>;
}

export const CatalogCtx = createContext<Ctx | null>(null);

function ready(bundle: CatalogBundle, origin: string): State {
  const catalog = new Catalog(bundle);
  const risk = riskMap(catalog);
  const search = new EntitySearch(bundle.entities, {
    ...propertyFacets(propertyDefs(bundle)),
    risk: (e) => {
      const r = risk.get(e.id);
      return r ? [r.severity] : [];
    },
  });
  return { status: "ready", catalog, search, origin };
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  // In the Splunk app: the catalog published to this Splunk's KV store; elsewhere a URL.
  const load = useCallback(() => {
    const fail = (err: Error) => setState({ status: "error", message: err.message });
    const override = new URLSearchParams(window.location.search).get("bundle");
    if (IN_SPLUNK && !override) {
      return fetchSplunkCatalog()
        .then((r) =>
          r
            ? setState(ready(r.bundle, `published to Splunk ${r.pointer.publishedAt ?? ""}`.trim()))
            : fail(
                new Error(
                  "No catalog found. Either none has been published to this Splunk yet " +
                    "(build it on the Build page, or see the app's README), or you need the delvecat_user role.",
                ),
              ),
        )
        .catch(fail);
    }
    const url = defaultBundleUrl();
    return fetchBundle(url)
      .then((b) => setState(ready(b, url)))
      .catch(fail);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Local files are parsed in the browser and never uploaded anywhere.
  const openFiles = useCallback(async (files: File[]) => {
    try {
      const { bundle, label } = await openLocalFiles(files);
      setState(ready(bundle, label));
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }, []);

  const value = useMemo(() => ({ state, openFiles, reload: load }), [state, openFiles, load]);
  return <CatalogCtx.Provider value={value}>{children}</CatalogCtx.Provider>;
}

export function useCatalogState(): Ctx {
  const ctx = useContext(CatalogCtx);
  if (!ctx) throw new Error("useCatalogState must be used inside CatalogProvider");
  return ctx;
}

/** For pages rendered only once the catalog is ready. */
export function useCatalog() {
  const { state } = useCatalogState();
  if (state.status !== "ready") throw new Error("catalog not ready");
  return state;
}

/** Structured property definitions, or none when no catalog is loaded. */
export function usePropertyDefs() {
  const ctx = useContext(CatalogCtx);
  return ctx?.state.status === "ready" ? propertyDefs(ctx.state.catalog.bundle) : [];
}

/** What puts an object at risk, or undefined (also when no catalog is loaded). */
export function useRisk(id: string): Risk | undefined {
  const ctx = useContext(CatalogCtx);
  return ctx?.state.status === "ready" ? riskMap(ctx.state.catalog).get(id) : undefined;
}
