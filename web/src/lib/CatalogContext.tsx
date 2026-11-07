import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogBundle } from "../generated/catalog";
import { Catalog, defaultBundleUrl, fetchBundle, openLocalFiles } from "./catalog";
import { riskMap, type Risk } from "./risk";
import { EntitySearch } from "./search";
import { propertyDefs, propertyFacets } from "./structured";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog; search: EntitySearch; origin: string };

interface Ctx {
  state: State;
  openFiles: (files: File[]) => Promise<void>;
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

  useEffect(() => {
    const url = defaultBundleUrl();
    fetchBundle(url)
      .then((b) => setState(ready(b, url)))
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  }, []);

  // Local files are parsed in the browser and never uploaded anywhere.
  const openFiles = useCallback(async (files: File[]) => {
    try {
      const { bundle, label } = await openLocalFiles(files);
      setState(ready(bundle, label));
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }, []);

  const value = useMemo(() => ({ state, openFiles }), [state, openFiles]);
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
