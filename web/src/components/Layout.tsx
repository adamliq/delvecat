import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { CommandPalette, Menu, SearchBox } from "./NavParts";
import { ADMIN, ago, changesSeen, HELP, markChangesSeen, menuOf, MENUS } from "../lib/nav";
import { useCatalogState } from "../lib/CatalogContext";
import { findings } from "../lib/findings";
import { canBuild } from "../lib/splunkBuild";
import { IN_SPLUNK, splunkHomeUrl } from "../lib/splunkSource";
import { applyTheme, chooseTheme, savedTheme, type ThemeChoice } from "../lib/theme";

export function Layout({ children }: { children: ReactNode }) {
  const header = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<ThemeChoice>(savedTheme);
  useEffect(() => { void applyTheme(); }, []);
  // The header's height, for what sticks below it ("On this page", table headers).
  useEffect(() => {
    const el = header.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--header-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { state, openFiles, full, scope, setScope } = useCatalogState();
  const navigate = useNavigate();
  const location = useLocation();
  const ready = state.status === "ready" ? state : null;
  const findingCount = useMemo(() => (ready ? findings(ready.catalog.entities).length : 0), [ready]);
  const criticalCount = useMemo(
    () => (ready ? ready.catalog.entities.filter((e) => e.health?.status === "critical").length : 0),
    [ready],
  );
  const bundle = ready?.catalog.bundle;
  const changes = bundle?.changes;
  const changeCount = changes ? changes.added.length + changes.modified.length + changes.removed.length : 0;
  // A build published since the viewer last opened Changes.
  const [seen, setSeen] = useState(changesSeen);
  useEffect(() => {
    if (location.pathname === "/changes" && bundle) { markChangesSeen(bundle.generatedAt); setSeen(bundle.generatedAt); }
  }, [location.pathname, bundle]);
  const newBuild = !!bundle && !!changes && seen !== bundle.generatedAt && changeCount > 0;
  const [menuOpen, setMenuOpen] = useState(false); // small screens
  useEffect(() => setMenuOpen(false), [location.pathname]);

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

  const section = menuOf(location.pathname);
  const badge = (n: number, label: string, cls = "") =>
    n > 0 ? <span className={`nav-badge${cls}`} aria-label={`${n} ${label}`}>{n > 999 ? "999+" : n}</span> : null;
  const allInstances = full.status === "ready" ? full.catalog.bundle.instances : [];

  return (
    <div className="shell">
      <header className={`topbar${menuOpen ? " menu-open" : ""}`} ref={header}>
        <Link to="/" className="brand">
          <span className="logo" aria-hidden>LD</span> Licoryx Delvecat
        </Link>
        <button type="button" className="menu-toggle btn" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? "Close" : "Menu"}
        </button>
        <nav className="nav" id="main-nav" aria-label="Main">
          {MENUS.map((m) => (
            <Menu
              key={m.id}
              label={m.label}
              active={section === m.id}
              badge={m.id === "quality" ? badge(findingCount, "findings") : undefined}
              items={m.items.map((i) => ({
                ...i,
                badge: i.to === "/findings" ? badge(findingCount, "findings")
                  : i.to === "/health" ? badge(criticalCount, "critical", " nav-badge-critical")
                  : i.to === "/changes" && newBuild ? badge(changeCount, "changes in a new build", " nav-badge-new")
                  : undefined,
              }))}
            />
          ))}
          <NavLink to={HELP.to} className="nav-link">{HELP.label}</NavLink>
        </nav>
        <SearchBox search={ready?.search} />
        <button type="button" className="btn btn-small palette-button" title="Go to a page or object (Ctrl+K)" onClick={() => window.dispatchEvent(new Event("delvecat:palette"))}>
          Go to… <kbd>Ctrl K</kbd>
        </button>
        {allInstances.length > 1 && (
          <label className="stack-pick">
            <span className="visually-hidden">Stack</span>
            <select value={scope} aria-label="Show one stack" onChange={(e) => setScope(e.target.value)}>
              <option value="">All stacks ({allInstances.length})</option>
              {allInstances.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id}</option>)}
            </select>
          </label>
        )}
        {bundle && (
          <Link to="/changes" className={`freshness${newBuild ? " is-new" : ""}`} title={`Built ${new Date(bundle.generatedAt).toLocaleString()}${newBuild ? ": new since you last looked at Changes" : ""}`}>
            {newBuild && <span className="dot" aria-hidden />}Built {ago(bundle.generatedAt)}
          </Link>
        )}
        {IN_SPLUNK ? (
          // In the Splunk app the catalog comes from Splunk; this is the way back.
          <div className="open-buttons">
            {builder && (
              <NavLink className="btn" to="/build" title="Build the catalog of this Splunk now">
                Build
              </NavLink>
            )}
            {builder && <Menu label="Admin" items={ADMIN} active={section === "admin"} align="right" />}
            <a className="btn" href={splunkHomeUrl()} title="Back to Splunk's home page">
              Splunk
            </a>
          </div>
        ) : (
          <div className="open-buttons">
            <LoadMenu onFile={() => fileInput.current?.click()} onFolder={() => folderInput.current?.click()} />
          </div>
        )}
        <input ref={fileInput} type="file" accept="application/json,.json" multiple hidden onChange={onPick} />
        <input ref={folderInput} type="file" hidden onChange={onPick} />
      </header>
      <CommandPalette search={ready?.search} byId={ready?.catalog.byId} />
      <main className="content">{children}</main>
      <footer className="footer">
        <label className="theme-pick">
          Theme{" "}
          <select value={theme} aria-label="Theme" onChange={(e) => { const t = e.target.value as ThemeChoice; setTheme(t); chooseTheme(t); }}>
            <option value="auto">{IN_SPLUNK ? "Automatic (as Splunk)" : "Automatic (as the system)"}</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
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

/** Outside Splunk: open a catalog from this computer (read in the browser, never uploaded). */
function LoadMenu({ onFile, onFolder }: { onFile: () => void; onFolder: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (fn: () => void) => { setOpen(false); fn(); };
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>Load catalog ▾</button>
      {open && (
        <div className="menu-panel menu-right" role="menu">
          <button type="button" role="menuitem" className="menu-item" onClick={() => pick(onFile)}>
            <span className="menu-item-label">Open file</span>
            <span className="menu-item-hint">A catalog.json bundle from your computer. Read in the browser, never uploaded.</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => pick(onFolder)}>
            <span className="menu-item-label">Open folder</span>
            <span className="menu-item-hint">A sharded bundle folder (catalog.json, entities/, edges.json).</span>
          </button>
        </div>
      )}
    </div>
  );
}
