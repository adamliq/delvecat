import { useState } from "react";
import type { DailySeries } from "../lib/health";
import { dayLabel } from "../lib/health";

/** Daily counts: one series, 2px line, hover a day for its value, latest value labelled.
 * One hover area for the whole chart (not one per day): tables show hundreds of these. */
export function Sparkline({ series, width = 160, height = 36, label, unit = "events" }: {
  series: DailySeries; width?: number; height?: number; label?: string; unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { counts, start } = series;
  const max = Math.max(1, ...counts);
  const pad = 3;
  const step = counts.length > 1 ? (width - pad * 2) / (counts.length - 1) : 0;
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const points = counts.map((v, i) => `${pad + i * step},${y(v)}`).join(" ");
  const last = counts[counts.length - 1];
  const tip = (i: number) => `${dayLabel(start, i)}: ${counts[i].toLocaleString()} ${unit}${i === counts.length - 1 ? " (today, still filling)" : ""}`;
  return (
    <span className="spark">
      <svg width={width} height={height} role="img"
        aria-label={`${label ?? "Daily events"}: ${counts.map((c, i) => `${dayLabel(start, i)} ${c}`).join(", ")}`}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const i = step ? Math.round((e.clientX - box.left - pad) / step) : 0;
          setHover(Math.max(0, Math.min(counts.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}>
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="spark-base" />
        <polyline points={points} className="spark-line" />
        <circle cx={pad + (counts.length - 1) * step} cy={y(last)} r={3} className="spark-dot" />
        {hover !== null && (
          <g>
            <line x1={pad + hover * step} x2={pad + hover * step} y1={0} y2={height} className="spark-base" />
            <circle cx={pad + hover * step} cy={y(counts[hover])} r={3} className="spark-dot" />
          </g>
        )}
        <rect x={0} y={0} width={width} height={height} className="spark-hit"><title>{hover !== null ? tip(hover) : tip(counts.length - 1)}</title></rect>
      </svg>
      <span className="spark-value">{(hover !== null ? counts[hover] : last).toLocaleString()}</span>
    </span>
  );
}
