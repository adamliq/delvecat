import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useCatalogState } from "../lib/CatalogContext";
import { searchPath } from "../lib/routes";
import { canBuild } from "../lib/splunkBuild";
import { IN_SPLUNK, splunkHomeUrl } from "../lib/splunkSource";

export function Layout({ children }: { children: ReactNode }) {
  const { state, openFiles } = useCatalogState();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length) void openFiles(files).then(() => navigate("/"));
  };

  // The Build button is for those who may build (delvecat_publisher, admins).
  const [builder, setBuilder] = useState(false);
  useEffect(() => {
    if (IN_SPLUNK) void canBuild().then(setBuilder);
  }, []);

  useEffect(() => {
    // React does not type the non-standard directory picker attribute.
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    navigate(searchPath({ q }));
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden>DC</span> DelveCat
        </Link>
        <nav className="nav">
          <NavLink to="/search">Browse</NavLink>
          <NavLink to="/domains">Domains</NavLink>
          <NavLink to="/schemas">Schemas</NavLink>
          <NavLink to="/glossary">Glossary</NavLink>
          <NavLink to="/coverage">Coverage</NavLink>
          <NavLink to="/health">Health</NavLink>
          <NavLink to="/governance">Governance</NavLink>
          <NavLink to="/insights">Insights</NavLink>
          <NavLink to="/sql">SQL</NavLink>
        </nav>
        <form className="search-box" onSubmit={submit} role="search">
          <input
            type="search"
            placeholder="Search indexes, searches, dashboards, macros…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search the catalog"
          />
        </form>
        {IN_SPLUNK ? (
          // In the Splunk app the catalog comes from Splunk; this is the way back.
          <div className="open-buttons">
            {builder && (
              <NavLink className="btn" to="/build" title="Build the catalog of this Splunk now">
                Build
              </NavLink>
            )}
            <a className="btn" href={splunkHomeUrl()} title="Back to Splunk's home page">
              Splunk
            </a>
          </div>
        ) : (
        <div className="open-buttons">
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}
            title="Open a catalog.json bundle from your computer. It is read in the browser and never uploaded.">
            Open file
          </button>
          <button type="button" className="btn" onClick={() => folderInput.current?.click()}
            title="Open a sharded bundle folder (catalog.json + entities/ + edges.json).">
            Open folder
          </button>
        </div>
        )}
        <input ref={fileInput} type="file" accept="application/json,.json" multiple hidden onChange={onPick} />
        <input ref={folderInput} type="file" hidden onChange={onPick} />
      </header>
      <main className="content">{children}</main>
      <footer className="footer">
        {state.status === "ready" && (
          <>
            Bundle generated {new Date(state.catalog.bundle.generatedAt).toLocaleString()} · source{" "}
            <code>{state.origin}</code> · read-only snapshot
            {state.catalog.bundle.mergedFrom && <> · merged from {state.catalog.bundle.mergedFrom.length} bundles</>}
            {state.catalog.bundle.redaction && (
              <> · <strong>redacted ({String(state.catalog.bundle.redaction.profile)} profile)</strong>: user and host names are pseudonyms</>
            )}
          </>
        )}
      </footer>
    </div>
  );
}
