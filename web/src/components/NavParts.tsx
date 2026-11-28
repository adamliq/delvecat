import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import { useSearchReady, type EntitySearch } from "../lib/search";
import { typeLabel } from "../lib/labels";
import { ALL_PAGES, type NavItem } from "../lib/nav";
import { recentIds } from "../lib/recent";
import { entityPath, searchPath } from "../lib/routes";

/** Whether the screen is narrow (the bar folds behind a Menu button). */
export function useNarrow(query = "(max-width: 900px)"): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, [query]);
  return narrow;
}

/** A menu in the bar: a button that opens its pages. Keyboard: Enter, Space or Arrow Down
 * opens it on the first page, Arrow Up on the last; arrows, Home and End move; Escape
 * closes it and returns to the button; Tab moves on and closes it. Closes on an outside
 * click or navigation. On narrow screens (inside the Menu sheet) its pages are listed
 * under its name instead, one tap away. */
export function Menu({ label, items, active, badge, align = "left", flat = false }: {
  label: string;
  items: (NavItem & { badge?: ReactNode })[];
  active?: boolean;
  badge?: ReactNode;
  align?: "left" | "right";
  /** List the pages under the label (no button): the small-screen Menu sheet. */
  flat?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focusAt, setFocusAt] = useState<"first" | "last" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const itemsEls = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open || !focusAt) return;
    const els = itemsEls();
    (focusAt === "first" ? els[0] : els[els.length - 1])?.focus();
    setFocusAt(null);
  }, [open, focusAt]);
  if (flat) {
    const id = `menu-${label.replace(/\W+/g, "-").toLowerCase()}`;
    return (
      <div className={`menu menu-flat${active ? " active" : ""}`} role="group" aria-labelledby={id}>
        <div className="menu-flat-label" id={id}>{label}{badge}</div>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} className="menu-item">
            <span className="menu-item-label">{i.label}{i.badge}</span>
            <span className="menu-item-hint">{i.hint}</span>
          </NavLink>
        ))}
      </div>
    );
  }
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setFocusAt(e.key === "ArrowDown" ? "first" : "last");
    }
  };
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemsEls();
    const at = els.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); els[(i + els.length) % els.length]?.focus(); };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(els.length - 1);
    else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className={`menu${active ? " active" : ""}`} ref={ref}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
      <button ref={button} type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open) setFocusAt("first"); }} onKeyDown={onButtonKey}>
        {label}{badge}<span className="menu-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className={`menu-panel menu-${align}`} role="menu" aria-label={label} onKeyDown={onPanelKey}>
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

/** ``value`` once it has stopped changing for ``ms`` (at once when ``ms`` is 0), and a way to
 * take the latest value now (a key that acts on the suggestions). */
export function useSettled<T>(value: T, ms: number): [T, () => void] {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!ms) return;
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [ms ? settled : value, () => setSettled(value)];
}

/** How long typing must pause before suggesting: on large catalogs one search takes a few
 * hundred ms, too long to run for every key (and the keys would lag). */
export const suggestDelay = (search?: EntitySearch) => (search && search.size > 20000 ? 150 : 0);

/** The search box: suggestions while typing (Enter opens Browse with the query), and "/"
 * anywhere to jump to it. A combobox: the arrow keys move through the suggestions, and
 * screen readers hear the one chosen. */
export function SearchBox({ search }: { search?: EntitySearch }) {
  const indexReady = useSearchReady(search);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const listId = useId();
  const [typed, flush] = useSettled(q.trim(), suggestDelay(search));
  // Leaving the box hides the suggestions a moment later (a click on one lands first);
  // coming back before then keeps them.
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
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
  // Pages whose name matches come first (typing "health" offers the Health page), then
  // objects, an exact name first (search ranks those first).
  const suggestions = useMemo(() => {
    const t = typed.toLowerCase();
    if (t.length < 2) return [];
    const pages = ALL_PAGES.filter((p) => p.label.toLowerCase().startsWith(t)).slice(0, 3)
      .map((p) => ({ key: `page:${p.to}`, to: p.to, kind: "Page", label: p.label, spl: false }));
    const objects = search ? search.suggest(typed, 8 - pages.length)
      .map((e) => ({ key: e.id, to: entityPath(e.id), kind: typeLabel(e.type), label: name(e), spl: e.type === "adhocSearch" })) : [];
    return [...pages, ...objects];
  }, [search, typed, indexReady]);
  const open = focus && suggestions.length > 0;
  const all = suggestions.length; // the last option: "All results for …"
  const optionId = (i: number) => `${listId}-${i}`;
  const go = (to: string) => { setFocus(false); setQ(""); setSel(-1); input.current?.blur(); navigate(to); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Still waiting for typing to pause: suggest for what is typed now, from the top.
      if (typed !== q.trim()) { flush(); setSel(e.key === "ArrowDown" ? 0 : -1); return; }
      setSel((s) => (e.key === "ArrowDown" ? Math.min(s + 1, all) : Math.max(s - 1, -1)));
    } else if (e.key === "Escape") { setFocus(false); input.current?.blur(); }
  };
  return (
    <form className="search-box" role="search" onSubmit={(e) => {
      e.preventDefault();
      go(sel >= 0 && sel < all ? suggestions[sel].to : searchPath({ q }));
    }}>
      <input
        ref={input}
        type="search"
        placeholder="Search the catalog  ( / )"
        value={q}
        onChange={(e) => { setQ(e.target.value); setSel(-1); }}
        onFocus={() => { clearTimeout(blurTimer.current); setFocus(true); }}
        onBlur={() => { blurTimer.current = setTimeout(() => setFocus(false), 150); }}
        onKeyDown={onKey}
        role="combobox"
        aria-label="Search the catalog"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && sel >= 0 ? optionId(sel) : undefined}
      />
      {open && (
        <ul className="suggest" role="listbox" id={listId} aria-label="Suggestions">
          {suggestions.map((e, i) => (
            <li key={e.key} id={optionId(i)} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined}
              onMouseDown={(ev) => { ev.preventDefault(); go(e.to); }}>
              <span className="type-tag">{e.kind}</span> <span className={e.spl ? "spl-title" : undefined}>{e.label}</span>
            </li>
          ))}
          <li id={optionId(all)} role="option" aria-selected={sel === all} className={`suggest-all${sel === all ? " selected" : ""}`}
            onMouseDown={(ev) => { ev.preventDefault(); go(searchPath({ q })); }}>All results for “{q}” →</li>
        </ul>
      )}
    </form>
  );
}

/** Ctrl+K (or ⌘K): jump to any page or object by name; recently viewed objects first. A
 * dialog: Layout puts the page behind it out of reach while it is open, Escape closes it
 * wherever focus is, and focus goes back to where it was. */
export function CommandPalette({ open, setOpen, search, byId }: {
  open: boolean; setOpen: (open: boolean) => void; search?: EntitySearch; byId?: Map<string, Entity>;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const listId = useId();
  const indexReady = useSearchReady(search);
  const opener = useRef<Element | null>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  useEffect(() => {
    const show = () => { opener.current = document.activeElement; setQ(""); setSel(0); setOpen(true); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isOpen.current) setOpen(false);
        else show();
      } else if (e.key === "Escape" && isOpen.current) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("delvecat:palette", show);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("delvecat:palette", show); };
  }, [setOpen]);
  // Closed: back to where it was opened from (the page is reachable again by now).
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }, [open]);
  const [typed, flush] = useSettled(q.trim().toLowerCase(), suggestDelay(search));
  const rowsFor = (t: string) => {
    const pages = ALL_PAGES.filter((p) => !t || p.label.toLowerCase().includes(t) || p.hint.toLowerCase().includes(t))
      .map((p) => ({ key: `page:${p.to}`, to: p.to, label: p.label, kind: "Page" }));
    const objects: Entity[] = t.length >= 2 && search
      ? search.suggest(t, 12)
      : recentIds().map((id) => byId?.get(id)).filter((e): e is Entity => !!e).slice(0, 8);
    return [...pages.slice(0, t ? 6 : 4), ...objects.map((e) => ({ key: e.id, to: entityPath(e.id), label: name(e), kind: typeLabel(e.type) }))];
  };
  const rows = useMemo(() => rowsFor(typed), [typed, search, byId, indexReady]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const pending = typed !== q.trim().toLowerCase();
  const go = (to: string) => { setOpen(false); navigate(to); };
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Go to" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type="text"
          placeholder="Go to a page or object…"
          value={q}
          role="combobox"
          aria-label="Go to a page or object"
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length ? listId : undefined}
          aria-activedescendant={rows[sel] ? optionId(sel) : undefined}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (pending) { flush(); setSel(0); return; }
              setSel((s) => (e.key === "ArrowDown" ? Math.min(s + 1, rows.length - 1) : Math.max(s - 1, 0)));
            } else if (e.key === "Enter") {
              // Typed faster than the pause: go where the text typed now leads.
              const now = pending ? rowsFor(q.trim().toLowerCase()) : rows;
              if (now[pending ? 0 : sel]) go(now[pending ? 0 : sel].to);
            }
          }}
        />
        {rows.length ? (
          <ul className="palette-list" role="listbox" id={listId} aria-label="Pages and objects">
            {rows.map((r, i) => (
              <li key={r.key} id={optionId(i)} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined}
                onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); go(r.to); }}>
                <span className="type-tag">{r.kind}</span> {r.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted palette-empty">Nothing matches.</p>
        )}
        <p className="muted small palette-foot">{q.trim() ? "Pages, then matching objects." : "Pages, then the objects you viewed last."} <Link to={searchPath({ q })} onClick={() => setOpen(false)}>Search everything</Link> · Esc to close</p>
      </div>
    </div>
  );
}
