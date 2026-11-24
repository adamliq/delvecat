import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

/** A <details> whose contents are built only once it is opened: a page with thousands
 * of collapsed panels then costs one summary each, not every panel's contents. */
export function LazyDetails({ summary, className, children }: { summary: ReactNode; className?: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  // Printed reports show every panel open.
  useEffect(() => {
    const before = () => { flushSync(() => setOpen(true)); if (ref.current) ref.current.open = true; };
    window.addEventListener("beforeprint", before);
    return () => window.removeEventListener("beforeprint", before);
  }, []);
  return (
    <details ref={ref} className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}
