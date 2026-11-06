import type { DailySeries } from "../lib/health";
import { dayLabel } from "../lib/health";

/** Daily event counts: one series, 2px line, hover a day for its value, latest value labelled. */
export function Sparkline({ series, width = 160, height = 36, label }: {
  series: DailySeries; width?: number; height?: number; label?: string;
}) {
  const { counts, start } = series;
  const max = Math.max(1, ...counts);
  const pad = 3;
  const step = counts.length > 1 ? (width - pad * 2) / (counts.length - 1) : 0;
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const points = counts.map((v, i) => `${pad + i * step},${y(v)}`).join(" ");
  const last = counts[counts.length - 1];
  return (
    <span className="spark">
      <svg width={width} height={height} role="img"
        aria-label={`${label ?? "Daily events"}: ${counts.map((c, i) => `${dayLabel(start, i)} ${c}`).join(", ")}`}>
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="spark-base" />
        <polyline points={points} className="spark-line" />
        <circle cx={pad + (counts.length - 1) * step} cy={y(last)} r={3} className="spark-dot" />
        {counts.map((v, i) => (
          <rect key={i} x={pad + i * step - step / 2} y={0} width={Math.max(step, 6)} height={height} className="spark-hit">
            <title>{`${dayLabel(start, i)}: ${v.toLocaleString()} events${i === counts.length - 1 ? " (today, still filling)" : ""}`}</title>
          </rect>
        ))}
      </svg>
      <span className="spark-value">{last.toLocaleString()}</span>
    </span>
  );
}
