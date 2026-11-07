import type { ReactNode } from "react";

/** A thin bar for one value in a table cell, with the number beside it (never color alone). */
export function Meter({ value, max, label, name }: { value: unknown; max: number; label: ReactNode; name: string }) {
  if (typeof value !== "number") return <span className="muted">—</span>;
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <span className="meter-cell" title={`${name}: ${typeof label === "string" ? label : value}`}>
      <span className="meter" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="meter-label">{label}</span>
    </span>
  );
}
