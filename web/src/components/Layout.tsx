import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCatalogState } from "../lib/CatalogContext";
import { searchPath } from "../lib/routes";

export function Layout({ children }: { children: ReactNode }) {
  const { state, openFile } = useCatalogState();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

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
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          Open bundle
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f).then(() => navigate("/"));
            e.target.value = "";
          }}
        />
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
