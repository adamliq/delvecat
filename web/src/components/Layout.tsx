import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCatalogState } from "../lib/CatalogContext";
import { searchPath } from "../lib/routes";

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
        <form className="search-box" onSubmit={submit} role="search">
          <input
            type="search"
            placeholder="Search indexes, searches, dashboards, macros…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search the catalog"
          />
        </form>
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
        <input ref={fileInput} type="file" accept="application/json,.json" multiple hidden onChange={onPick} />
        <input ref={folderInput} type="file" hidden onChange={onPick} />
      </header>
      <main className="content">{children}</main>
      <footer className="footer">
        {state.status === "ready" && (
          <>
            Bundle generated {new Date(state.catalog.bundle.generatedAt).toLocaleString()} · source{" "}
            <code>{state.origin}</code> · read-only snapshot
          </>
        )}
      </footer>
    </div>
  );
}
