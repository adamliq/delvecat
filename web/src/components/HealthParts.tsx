import { useState } from "react";
import { LazyDetails } from "./LazyDetails";
import type { CatalogBundle, Entity } from "../generated/catalog";
import { ackLabel, type Ack, type AckState } from "../lib/acks";
import { checkTitle } from "../lib/findings";
import { remedy, searchLink, type CheckCount, type Item } from "../lib/healthView";

type Point = NonNullable<CatalogBundle["healthHistory"]>[number];

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
/** Axis labels: dates, or times when every build is on the same day. */
const axisLabel = (iso: string, sameDay: boolean) =>
  sameDay ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : shortDate(iso);

/** Objects with critical and with warning findings per build: two lines, one axis. */
export function HealthTrend({ history }: { history: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const height = 150;
  const pad = { l: 36, r: 84, t: 10, b: 22 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = history.length;
  const top = Math.max(1, ...history.map((h) => Math.max(h.critical, h.warning)));
  const nice = [1, 2, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(top))).find((m) => m >= top) ?? top;
  const x = (i: number) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - (v / nice) * plotH;
  const line = (k: "critical" | "warning") => history.map((h, i) => `${i ? "L" : "M"}${x(i)},${y(h[k])}`).join(" ");
  const last = history[n - 1];
  const sameDay = shortDate(history[0].at) === shortDate(last.at);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / plotW) * (n - 1)))));
  };
  return (
    <figure className="health-trend">
      <figcaption>
        <strong>Objects with findings, per build</strong>{" "}
        <span className="legend-item"><span className="legend-swatch sw-critical" aria-hidden="true" /> critical</span>{" "}
        <span className="legend-item"><span className="legend-swatch sw-warning" aria-hidden="true" /> warning</span>
      </figcaption>
      <div className="sql-chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          aria-label={`Health over ${n} builds: now ${last.critical} critical and ${last.warning} warning`}>
          {[0, nice / 2, nice].map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={pad.l + plotW} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.l - 6} y={y(t)} className="chart-axis" textAnchor="end" dominantBaseline="middle">{t.toLocaleString()}</text>
            </g>
          ))}
          <text x={pad.l} y={height - 6} className="chart-axis">{axisLabel(history[0].at, sameDay)}</text>
          <text x={pad.l + plotW} y={height - 6} className="chart-axis" textAnchor="end">{axisLabel(last.at, sameDay)}</text>
          <path d={line("warning")} className="trend-line trend-warning" />
          <path d={line("critical")} className="trend-line trend-critical" />
          <text x={x(n - 1) + 8} y={y(last.critical)} className="chart-label" dominantBaseline="middle">{last.critical} critical</text>
          <text x={x(n - 1) + 8} y={y(last.warning) + (Math.abs(y(last.warning) - y(last.critical)) < 12 ? 12 : 0)} className="chart-label" dominantBaseline="middle">{last.warning} warning</text>
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="chart-crosshair" />
              <circle cx={x(hover)} cy={y(history[hover].warning)} r={4.5} className="trend-dot trend-warning" />
              <circle cx={x(hover)} cy={y(history[hover].critical)} r={4.5} className="trend-dot trend-critical" />
            </g>
          )}
        </svg>
        {hover !== null && (
          <div className="chart-tip" role="status" style={{ left: `${(x(hover) / width) * 100}%`, right: "auto", top: 0 }}>
            <strong>{new Date(history[hover].at).toLocaleString()}</strong>: {history[hover].critical} critical, {history[hover].warning} warning
            {history[hover].findings !== undefined && <> · {history[hover].findings} findings</>}
          </div>
        )}
      </div>
    </figure>
  );
}

/** Findings per check as bars (critical, then warning); click one to filter to it. */
const BARS = 8;

export function CheckBars({ counts, selected, onSelect }: { counts: CheckCount[]; selected?: string; onSelect: (check: string | undefined) => void }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...counts.map((c) => c.critical + c.warning));
  const shown = all || counts.length <= BARS + 2 ? counts : counts.slice(0, BARS).concat(counts.filter((c, i) => i >= BARS && c.check === selected));
  return (
    <div className="check-bars" role="group" aria-label="Findings by check">
      {shown.map((c) => {
        const total = c.critical + c.warning;
        const active = selected === c.check;
        return (
          <button key={c.check} type="button" className={`check-bar${active ? " active" : ""}`} aria-pressed={active}
            onClick={() => onSelect(active ? undefined : c.check)}
            title={`${checkTitle(c.check)}: ${c.critical} critical, ${c.warning} warning. Click to ${active ? "show all" : "show only these"}.`}>
            <span className="check-bar-label">{checkTitle(c.check)}</span>
            <span className="check-bar-track">
              {c.critical > 0 && <span className="check-bar-seg seg-critical" style={{ width: `${(c.critical / max) * 100}%` }} />}
              {c.warning > 0 && <span className="check-bar-seg seg-warning" style={{ width: `${(c.warning / max) * 100}%` }} />}
            </span>
            <span className="check-bar-num">{total.toLocaleString()}</span>
          </button>
        );
      })}
      {counts.length > BARS + 2 && (
        <button type="button" className="link-btn small check-bars-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${counts.length} checks`}
        </button>
      )}
    </div>
  );
}

/** Why it matters, what to do, and a search to look into it (built when opened). */
export function RemedyBox({ item, webUrl, inSplunk, prefix }: { item: Item; webUrl?: string; inSplunk: boolean; prefix: string }) {
  if (!remedy(item.check)) return null;
  return (
    <LazyDetails className="remedy" summary="How to fix">
      {() => <RemedyBody item={item} webUrl={webUrl} inSplunk={inSplunk} prefix={prefix} />}
    </LazyDetails>
  );
}

function RemedyBody({ item, webUrl, inSplunk, prefix }: { item: Item; webUrl?: string; inSplunk: boolean; prefix: string }) {
  const r = remedy(item.check)!;
  const [copied, setCopied] = useState(false);
  const spl = r.spl?.(item.entity);
  const link = spl ? searchLink(spl, webUrl, inSplunk, prefix) : undefined;
  const copy = async () => {
    if (!spl) return;
    try {
      await navigator.clipboard.writeText(spl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this search", spl);
    }
  };
  return (
    <>
      <p><strong>Why it matters.</strong> {r.why}</p>
      <p><strong>What to do.</strong> {r.fix}</p>
      {spl && (
        <div className="remedy-spl">
          <code>{spl}</code>
          <div>
            {link && <a className="btn btn-small" href={link} target="_blank" rel="noreferrer">Open in Splunk search</a>}{" "}
            <button type="button" className="btn btn-small" onClick={() => void copy()}>{copied ? "Copied" : "Copy search"}</button>
          </div>
        </div>
      )}
    </>
  );
}

const SNOOZE_DAYS = [7, 30, 90];

/** Accept or snooze a finding, or undo it. */
export function AckControl({ item, canWrite, onSave, onRemove }: {
  item: Item;
  canWrite: boolean;
  onSave: (state: AckState, days: number | undefined, note: string) => Promise<void>;
  onRemove: (ack: Ack) => Promise<void>;
}) {
  const [choice, setChoice] = useState("accept");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (item.ack) {
    return (
      <div className={`ack-state${item.handled ? "" : " ack-lapsed"}`}>
        <span className="muted small">{ackLabel(item.ack)}{item.ack.note ? `: ${item.ack.note}` : ""}{!item.handled && item.ack.state === "accepted" ? " (it has got worse since)" : ""}</span>
        {canWrite && <button type="button" className="link-btn small" disabled={busy} onClick={() => void act(() => onRemove(item.ack!))}>Undo</button>}
        {error && <div className="error small">{error}</div>}
      </div>
    );
  }
  if (!canWrite) return null;
  return (
    <LazyDetails className="ack-form" summary="Acknowledge">{() => (
      <form onSubmit={(e) => {
        e.preventDefault();
        const days = choice === "accept" ? undefined : Number(choice);
        void act(() => onSave(days ? "snoozed" : "accepted", days, note.trim()));
      }}>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Acknowledge how">
          <option value="accept">Accept (known, not fixing)</option>
          {SNOOZE_DAYS.map((d) => <option key={d} value={String(d)}>Snooze for {d} days</option>)}
        </select>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" maxLength={300} />
        <button type="submit" className="btn btn-small" disabled={busy}>Save</button>
        {error && <div className="error small">{error}</div>}
      </form>
    )}</LazyDetails>
  );
}

export function NewBadge() {
  return <span className="badge badge-new" title="Not in the previous build">new</span>;
}

/** The instance's Splunk Web, for search links. */
export function webUrlOf(bundle: CatalogBundle, e: Entity): string | undefined {
  return bundle.instances.find((i) => i.id === e.instance)?.webUrl ?? undefined;
}
