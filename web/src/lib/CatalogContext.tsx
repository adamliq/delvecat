import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { Catalog, defaultBundleUrl, fetchBundle, openLocalFiles } from "./catalog";
import { riskMap, type Risk } from "./risk";
import { IN_SPLUNK, fetchSplunkCatalog } from "./splunkSource";
import { lookupColumns } from "./lookups";
import { dataModelColumns } from "./dataModels";
import { schemaFields } from "./schema";
import { fieldName } from "./fieldLineage";
import { EntitySearch } from "./search";
import { isVendor } from "./insights";
import { propertyDefs, propertyFacets } from "./structured";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog; search: EntitySearch; origin: string };

interface Ctx {
  /** The catalog as the pages see it: limited to one stack when a scope is chosen. */
  state: State;
  /** The whole catalog, whatever the scope (Build page, export). */
  full: State;
  /** The stack every page is limited to, or "" for all of them. */
  scope: string;
  setScope: (instance: string) => void;
  openFiles: (files: File[]) => Promise<void>;
  /** Load the catalog again (after a build in the Splunk app). */
  reload: () => Promise<void>;
}

export const CatalogCtx = createContext<Ctx | null>(null);

const sourcetypeFieldNames = (catalog: Catalog, st: Entity) => schemaFields(catalog, st).map(fieldName);

function ready(bundle: CatalogBundle, origin: string): State {
  const catalog = new Catalog(bundle);
  const risk = riskMap(catalog);
  const stFields = new Map<string, string[]>();
  const search = new EntitySearch(bundle.entities, {
    ...propertyFacets(propertyDefs(bundle)),
    // Shipped with Splunk or a vendor app, or made here.
    origin: (e) => [isVendor(catalog, e) || (e.properties as { builtin?: boolean } | undefined)?.builtin === true ? "built-in" : "custom"],
    // Sourcetypes by the fields found on them; lookups, collections and data models by theirs.
    field: (e) => {
      if (e.type === "dataModel") return dataModelColumns(e);
      if (e.type !== "sourcetype") return lookupColumns(e);
      let names = stFields.get(e.id); // computed once: facets are counted on every query
      if (!names) stFields.set(e.id, (names = sourcetypeFieldNames(catalog, e)));
      return names;
    },
    risk: (e) => {
      const r = risk.get(e.id);
      return r ? [r.severity] : [];
    },
  });
  return { status: "ready", catalog, search, origin };
}

const SCOPE_KEY = "delvecat.scope";

/** The catalog limited to one stack: its instance, objects, and the relationships between them. */
export function scopedBundle(b: CatalogBundle, instance: string): CatalogBundle {
  const entities = b.entities.filter((e) => e.instance === instance);
  const ids = new Set(entities.map((e) => e.id));
  return {
    ...b,
    instances: b.instances.filter((i) => i.id === instance),
    entities,
    edges: b.edges.filter((x) => ids.has(x.from) && ids.has(x.to)),
  };
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

  // Limit every page to one stack (catalogs of several stacks); remembered per browser.
  const [scope, setScopeState] = useState<string>(() => {
    try { return localStorage.getItem(SCOPE_KEY) ?? ""; } catch { return ""; }
  });
  const setScope = useCallback((instance: string) => {
    setScopeState(instance);
    try { if (instance) localStorage.setItem(SCOPE_KEY, instance); else localStorage.removeItem(SCOPE_KEY); } catch { /* private mode */ }
  }, []);
  const scoped = useMemo<State>(() => {
    if (state.status !== "ready" || !scope) return state;
    const b = state.catalog.bundle;
    if (b.instances.length < 2 || !b.instances.some((i) => i.id === scope)) return state;
    return ready(scopedBundle(b, scope), state.origin);
  }, [state, scope]);
  const effectiveScope = scoped === state ? "" : scope;

  const value = useMemo(
    () => ({ state: scoped, full: state, scope: effectiveScope, setScope, openFiles, reload: load }),
    [scoped, state, effectiveScope, setScope, openFiles, load],
  );
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
