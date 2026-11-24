import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { EntitySearch } from "../lib/search";
import { typeLabel } from "../lib/labels";
import { ALL_PAGES, type NavItem } from "../lib/nav";
import { recentIds } from "../lib/recent";
import { entityPath, searchPath } from "../lib/routes";

/** A menu in the bar: a button that opens its pages. Closes on Escape, outside click or
 * navigation. */
export function Menu({ label, items, active, badge, align = "left" }: {
  label: string;
  items: (NavItem & { badge?: ReactNode })[];
  active?: boolean;
  badge?: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className={`menu${active ? " active" : ""}`} ref={ref} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="menu-button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}{badge}<span className="menu-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className={`menu-panel menu-${align}`} role="menu">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} role="menuitem" className="menu-item">
              <span className="menu-item-label">{i.label}{i.badge}</span>
              <span className="menu-item-hint">{i.hint}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

const name = (e: Entity) => e.displayName ?? e.name;

/** The search box: suggestions while typing (Enter opens Browse with the query), and "/"
 * anywhere to jump to it. */
export function SearchBox({ search }: { search?: EntitySearch }) {
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const suggestions = useMemo(
    () => (search && q.trim().length >= 2 ? search.query(q.trim()).results.slice(0, 8) : []),
    [search, q],
  );
  const go = (to: string) => { setFocus(false); setQ(""); setSel(-1); input.current?.blur(); navigate(to); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); }
    else if (e.key === "Escape") { setFocus(false); input.current?.blur(); }
  };
  return (
    <form className="search-box" role="search" onSubmit={(e) => {
      e.preventDefault();
      go(sel >= 0 && suggestions[sel] ? entityPath(suggestions[sel].id) : searchPath({ q }));
    }}>
      <input
        ref={input}
        type="search"
        placeholder="Search the catalog  ( / )"
        value={q}
        onChange={(e) => { setQ(e.target.value); setSel(-1); }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={onKey}
        aria-label="Search the catalog"
        aria-autocomplete="list"
        aria-expanded={focus && suggestions.length > 0}
      />
      {focus && suggestions.length > 0 && (
        <ul className="suggest" role="listbox">
          {suggestions.map((e, i) => (
            <li key={e.id} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined}
              onMouseDown={(ev) => { ev.preventDefault(); go(entityPath(e.id)); }}>
              <span className="type-tag">{typeLabel(e.type)}</span> <span className={e.type === "adhocSearch" ? "spl-title" : undefined}>{name(e)}</span>
            </li>
          ))}
          <li className="suggest-all" onMouseDown={(ev) => { ev.preventDefault(); go(searchPath({ q })); }}>All results for “{q}” →</li>
        </ul>
      )}
    </form>
  );
}

/** Ctrl+K (or ⌘K): jump to any page or object by name; recently viewed objects first. */
export function CommandPalette({ search, byId }: { search?: EntitySearch; byId?: Map<string, Entity> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setSel(0);
      }
    };
    const openIt = () => { setOpen(true); setQ(""); setSel(0); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("delvecat:palette", openIt);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("delvecat:palette", openIt); };
  }, []);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const pages = ALL_PAGES.filter((p) => !t || p.label.toLowerCase().includes(t) || p.hint.toLowerCase().includes(t))
      .map((p) => ({ key: `page:${p.to}`, to: p.to, label: p.label, kind: "Page" }));
    const objects: Entity[] = t.length >= 2 && search
      ? search.query(t).results.slice(0, 12)
      : recentIds().map((id) => byId?.get(id)).filter((e): e is Entity => !!e).slice(0, 8);
    return [...pages.slice(0, t ? 6 : 4), ...objects.map((e) => ({ key: e.id, to: entityPath(e.id), label: name(e), kind: typeLabel(e.type) }))];
  }, [q, search, byId]);
  if (!open) return null;
  const go = (to: string) => { setOpen(false); navigate(to); };
  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Go to" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type="text"
          placeholder="Go to a page or object…"
          value={q}
          aria-label="Go to a page or object"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter" && rows[sel]) go(rows[sel].to);
          }}
        />
        <ul className="palette-list" role="listbox">
          {rows.length === 0 && <li className="muted">Nothing matches.</li>}
          {rows.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined}
              onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); go(r.to); }}>
              <span className="type-tag">{r.kind}</span> {r.label}
            </li>
          ))}
        </ul>
        <p className="muted small palette-foot">{q.trim() ? "Pages, then matching objects." : "Pages, then the objects you viewed last."} <Link to={searchPath({ q })} onClick={() => setOpen(false)}>Search everything</Link> · Esc to close</p>
      </div>
    </div>
  );
}
