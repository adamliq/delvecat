import { useState } from "react";
import type { SqlValue } from "sql.js";

/** What a query result can be drawn as: bars (label + number) or a line (date + number). */
export interface ChartSpec {
  kind: "bar" | "line";
  labelColumn: number;
  valueColumn: number;
  points: { label: string; value: number }[];
  truncated: boolean;
}

const MAX_BARS = 40;
const DATE = /^\d{4}-\d{2}-\d{2}/;

const isNumber = (v: SqlValue) => typeof v === "number" && Number.isFinite(v);

/** A single label column and a single numeric column, or undefined if the result is not one. */
export function chartSpec(columns: string[], rows: SqlValue[][]): ChartSpec | undefined {
  if (rows.length < 2 || columns.length < 2) return undefined;
  const numeric = columns.map((_, j) => rows.every((r) => r[j] === null || isNumber(r[j])) && rows.some((r) => isNumber(r[j])));
  const text = columns.map((_, j) => rows.every((r) => r[j] === null || typeof r[j] === "string"));
  const labelColumn = text.findIndex(Boolean);
  const valueColumn = numeric.findIndex(Boolean);
  if (labelColumn < 0 || valueColumn < 0) return undefined;
  const all = rows
    .filter((r) => isNumber(r[valueColumn]))
    .map((r) => ({ label: String(r[labelColumn] ?? "—"), value: r[valueColumn] as number }));
  const dated = all.length >= 3 && all.every((p) => DATE.test(p.label));
  if (dated) {
    const points = [...all].sort((a, b) => a.label.localeCompare(b.label));
    return { kind: "line", labelColumn, valueColumn, points, truncated: false };
  }
  return { kind: "bar", labelColumn, valueColumn, points: all.slice(0, MAX_BARS), truncated: all.length > MAX_BARS };
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** Rounded data end (4px) on the right, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  if (w <= 0) return "";
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

export function SqlChart({ spec, columns }: { spec: ChartSpec; columns: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const title = columns[spec.valueColumn];
  return (
    <figure className="sql-chart">
      <figcaption>
        <strong>{title}</strong> <span className="muted small">by {columns[spec.labelColumn]}{spec.truncated ? ` · first ${MAX_BARS}; the table has them all` : ""}</span>
      </figcaption>
      {spec.kind === "bar" ? <Bars spec={spec} hover={hover} setHover={setHover} /> : <Line spec={spec} hover={hover} setHover={setHover} />}
    </figure>
  );
}

function Bars({ spec, hover, setHover }: { spec: ChartSpec; hover: number | null; setHover: (i: number | null) => void }) {
  const rowH = 22;
  const gap = 2;
  const labelW = 220;
  const valueW = 70;
  const width = 760;
  const plotW = width - labelW - valueW;
  const min = Math.min(0, ...spec.points.map((p) => p.value));
  const max = niceMax(Math.max(...spec.points.map((p) => p.value), 0));
  const scale = (v: number) => ((v - min) / (max - min || 1)) * plotW;
  const height = spec.points.length * rowH + 20;
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  return (
    <div className="sql-chart-plot" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Bar chart of ${spec.points.length} rows`} width="100%">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={labelW + scale(t)} x2={labelW + scale(t)} y1={0} y2={height - 18} className="chart-grid" />
            <text x={labelW + scale(t)} y={height - 4} className="chart-axis" textAnchor="middle">{fmt(t)}</text>
          </g>
        ))}
        {spec.points.map((p, i) => {
          const y = i * rowH;
          const x0 = labelW + scale(Math.min(0, p.value));
          const w = Math.abs(scale(p.value) - scale(0));
          return (
            <g key={i} onMouseEnter={() => setHover(i)} className={hover === i ? "chart-row hover" : "chart-row"}>
              <rect x={0} y={y} width={width} height={rowH} className="chart-hit" />
              <text x={labelW - 8} y={y + rowH / 2} className="chart-label" textAnchor="end" dominantBaseline="middle">
                {p.label.length > 32 ? `${p.label.slice(0, 31)}…` : p.label}
              </text>
              <path d={barPath(x0, y + gap + 3, w, rowH - 2 * gap - 6)} className="chart-bar" />
              <text x={x0 + w + 6} y={y + rowH / 2} className="chart-value" dominantBaseline="middle">{fmt(p.value)}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" role="status" style={{ top: `${((hover * rowH) / height) * 100}%` }}>
          <strong>{spec.points[hover].label}</strong>: {fmt(spec.points[hover].value)}
        </div>
      )}
    </div>
  );
}

function Line({ spec, hover, setHover }: { spec: ChartSpec; hover: number | null; setHover: (i: number | null) => void }) {
  const width = 760;
  const height = 260;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const max = niceMax(Math.max(...spec.points.map((p) => p.value), 0));
  const n = spec.points.length;
  const x = (i: number) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const path = spec.points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const ticks = [0, max / 2, max];
  const labelAt = [0, Math.floor((n - 1) / 2), n - 1];
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.round(((px - pad.l) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  return (
    <div className="sql-chart-plot">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Line chart of ${n} points`} width="100%" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t)} className="chart-axis" textAnchor="end" dominantBaseline="middle">{fmt(t)}</text>
          </g>
        ))}
        {[...new Set(labelAt)].map((i) => (
          <text key={i} x={x(i)} y={height - 8} className="chart-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {spec.points[i].label.slice(0, 10)}
          </text>
        ))}
        <path d={path} className="chart-line" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="chart-crosshair" />
            <circle cx={x(hover)} cy={y(spec.points[hover].value)} r={4.5} className="chart-dot" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" role="status" style={{ left: `${(x(hover) / width) * 100}%`, right: "auto", top: 0 }}>
          <strong>{spec.points[hover].label}</strong>: {fmt(spec.points[hover].value)}
        </div>
      )}
    </div>
  );
}
