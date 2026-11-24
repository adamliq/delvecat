import { useState, type ReactNode } from "react";

/** A <details> whose contents are built only once it is opened: a page with thousands
 * of collapsed panels then costs one summary each, not every panel's contents. */
export function LazyDetails({ summary, className, children }: { summary: ReactNode; className?: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}
