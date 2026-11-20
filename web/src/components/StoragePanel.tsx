import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { measuredAt } from "../lib/health";
import { fmtMB, retentionText, storageOf, storeText, tierNames } from "../lib/storage";
import { Meter } from "./Meter";

const fmtAge = (iso: string | undefined, now: number) => {
  if (!iso) return undefined;
  const days = (now - new Date(iso).getTime()) / 86400000;
  return days >= 1 ? `${Math.round(days).toLocaleString()} days` : "less than a day";
};

/** An index's retention and its storage tiers, named as on the instance's own platform
 * (Splunk Cloud or Splunk Enterprise) with the other platform's name alongside. */
export function StoragePanel({ entity }: { entity: Entity }) {
  const { catalog } = useCatalog();
  const s = storageOf(entity);
  const p = (entity.properties ?? {}) as Record<string, unknown>;
  const obs = (p.observed ?? {}) as Record<string, unknown>;
  const retention = retentionText(p);
  if (!s && !retention) return null;
  const cloud = catalog.bundle.instances.find((i) => i.id === entity.instance)?.kind === "splunkCloud";
  const smartStore = s?.model === "smartStore";
  const size = obs.currentDBSizeMB as number | undefined;
  const limit = (p.maxGlobalDataSizeMB ?? p.maxTotalDataSizeMB) as number | undefined;
  // Columns no tier has a value for are left out.
  const tiers = s?.tiers ?? [];
  const cols = {
    size: tiers.some((t) => t.sizeMB != null),
    limit: tiers.some((t) => t.maxSizeMB || t.maxBuckets),
    buckets: tiers.some((t) => t.buckets != null),
  };
  const oldest = fmtAge(obs.earliestEvent as string | undefined, measuredAt(catalog.bundle));
  return (
    <section>
      <h2>Storage and retention</h2>
      <dl className="facts">
        {retention && (
          <div className="fact-pair">
            <dt>{cloud ? "Searchable retention" : "Retention"}</dt>
            <dd>{retention}{cloud ? "" : " (Splunk Cloud: searchable retention)"}</dd>
          </div>
        )}
        {size != null && limit ? (
          <div className="fact-pair">
            <dt>Size</dt>
            <dd><Meter value={size} max={limit} name="Size used" label={`${fmtMB(size)} of ${fmtMB(limit)}`} /></dd>
          </div>
        ) : null}
        {oldest && <div className="fact-pair"><dt>Oldest data</dt><dd>{oldest} old</dd></div>}
        {s && <div className="fact-pair"><dt>Storage</dt><dd>{smartStore ? "SmartStore (remote object storage)" : cloud ? "Splunk Cloud managed" : "Local (classic) buckets"}</dd></div>}
      </dl>
      {s && (
        <div className="table-wrap">
          <table className="mini-table">
            <thead>
              <tr>
                <th>{cloud ? "Splunk Cloud" : "Tier"}</th>
                <th>{cloud ? "Splunk Enterprise" : "Splunk Cloud"}</th>
                <th>Location</th>
                {cols.size && <th>Size</th>}
                {cols.limit && <th>Limit</th>}
                {cols.buckets && <th>Buckets</th>}
              </tr>
            </thead>
            <tbody>
              {s.tiers.map((t) => {
                const n = tierNames(t, smartStore);
                const detail =
                  t.action === "activeArchive" && t.archiveRetentionDays
                    ? `kept ${t.archiveRetentionDays} days`
                    : storeText(t) ?? t.provider;
                return (
                  <tr key={t.tier}>
                    <td>{cloud ? n.cloud : n.enterprise}</td>
                    <td className="muted">{cloud ? n.enterprise : n.cloud}</td>
                    <td><code>{t.path ?? "—"}</code>{detail ? <span className="muted"> {detail}</span> : null}</td>
                    {cols.size && <td>{t.sizeMB != null ? fmtMB(t.sizeMB) : "—"}</td>}
                    {cols.limit && <td>{t.maxSizeMB ? fmtMB(t.maxSizeMB) : t.maxBuckets ? `${t.maxBuckets} bucket${t.maxBuckets === 1 ? "" : "s"}` : "—"}</td>}
                    {cols.buckets && <td>{t.buckets ?? "—"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
