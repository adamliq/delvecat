import { useEffect, useState } from "react";

/** "On this page": links to the sections (h2) of the overview that follows it, kept in
 * view while scrolling. Sections are found after rendering, so any panel can add one. */
export function SectionNav({ deps }: { deps: string }) {
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    const root = document.querySelector("[data-sections]");
    if (!root) return;
    const heads = [...root.querySelectorAll<HTMLHeadingElement>("section > h2")];
    const used = new Set<string>();
    setItems(heads.map((h) => {
      const title = (h.firstChild?.textContent ?? h.textContent ?? "").trim();
      let id = `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      while (used.has(id)) id += "-";
      used.add(id);
      h.id = id;
      return { id, title };
    }));
  }, [deps]);
  if (items.length < 4) return null;
  return (
    <nav className="section-nav" aria-label="On this page">
      <span className="muted small">On this page:</span>
      {items.map((i) => (
        <button key={i.id} type="button" className="link-btn small"
          onClick={() => document.getElementById(i.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          {i.title}
        </button>
      ))}
    </nav>
  );
}
