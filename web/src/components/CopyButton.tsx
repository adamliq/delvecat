import { useState } from "react";

/** A small button that copies text, says "Copied" briefly, and falls back to a prompt. */
export function CopyButton({ text, label, className = "btn btn-small" }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      window.prompt(label, text);
    }
  };
  return <button type="button" className={className} onClick={() => void copy()} title={label}>{done ? "Copied" : label}</button>;
}
