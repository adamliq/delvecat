import type { CatalogBundle } from "../generated/catalog";
import { coverageSummary, partRows, STATUS_WORDS, type PartRow } from "../lib/buildReport";
import { fmtDuration } from "../lib/propertyFormat";
import { DataTable } from "./DataTable";

const ORDER = { failed: 0, partial: 1, skipped: 2, ok: 3 };

/** What each part of the build did: read, skipped (and why) or failed, with counts and time. */
export function CoverageReport({ bundle, open }: { bundle: CatalogBundle; open?: boolean }) {
  const rows = partRows(bundle.ingestionReport ?? []);
  if (!rows.length) return null;
  const attention = rows.filter((r) => r.status !== "ok").length;
  const multi = new Set(rows.map((r) => r.instance).filter(Boolean)).size > 1;
  return (
    <details open={open ?? attention > 0} className="coverage-report">
      <summary>
        {coverageSummary(rows)}
        {attention > 0 && <span className="muted"> · skipped parts are usually products not installed here or not visible to the builder</span>}
      </summary>
      <DataTable<PartRow>
        rows={[...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status])}
        rowKey={(r) => `${r.instance ?? ""}|${r.connector}`}
        csvName="delvecat-build-parts.csv"
        columns={[
          { label: "Area", value: (r) => r.area },
          { label: "Part", value: (r) => r.part, render: (r) => <span title={r.connector}>{r.part}</span> },
          ...(multi ? [{ label: "Instance", value: (r: PartRow) => r.instance ?? "" }] : []),
          { label: "Status", value: (r) => ORDER[r.status], render: (r) => <span className={`status status-${r.status}`}>{STATUS_WORDS[r.status]}</span> },
          { label: "Objects", value: (r) => r.objects, render: (r) => (r.objects === undefined ? "—" : r.objects.toLocaleString()) },
          { label: "Time", value: (r) => r.seconds, render: (r) => (r.seconds === undefined ? "—" : fmtDuration(r.seconds)) },
          { label: "Why", value: (r) => r.reason ?? "" },
        ]}
      />
    </details>
  );
}
