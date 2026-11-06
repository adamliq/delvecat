import type { ReactNode } from "react";

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Render arbitrary JSON property values: scalars, lists, maps and lists of records. */
export function PropValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">none</span>;
    if (value.every(isScalar)) {
      return (
        <span className="chips">
          {value.map((v, i) => (
            <span key={i} className="chip">{String(v)}</span>
          ))}
        </span>
      );
    }
    const records = value as Record<string, unknown>[];
    const cols = [...new Set(records.flatMap((r) => Object.keys(r ?? {})))];
    return (
      <div className="table-wrap">
        <table className="mini-table">
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}><PropValue value={r?.[c]} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="muted">none</span>;
  return (
    <dl className="facts nested">
      {entries.map(([k, v]) => (
        <div key={k} className="fact-pair"><dt>{k}</dt><dd><PropValue value={v} /></dd></div>
      ))}
    </dl>
  );
}
