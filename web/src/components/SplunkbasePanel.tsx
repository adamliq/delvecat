import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";

/** What the Splunkbase Version Catalog app's catalogue says about an installed app
 * (properties.splunkbase, read by the build's "splunkbase" part). */
export interface SplunkbaseFacts {
  appId?: string;
  uid?: number;
  title?: string;
  latestVersion?: string;
  releaseDate?: string;
  updateAvailable?: boolean;
  archived?: boolean;
  splunkVersions?: string[];
  /** This Splunk's major.minor version, when the release lists any. */
  splunkVersion?: string;
  compatible?: boolean;
  cloudCompatible?: boolean;
  support?: string;
  url?: string;
  lastChecked?: string;
}

/** On the Splunkbase Version Catalog app itself: its catalogue in numbers. */
export interface SplunkbaseCatalog {
  apps?: number;
  installedHere?: number;
  updatesAvailable?: number;
  archived?: number;
  lastChecked?: string;
}

const SUPPORT: Record<string, string> = {
  splunk: "Splunk Supported",
  developer: "Developer Supported",
  none: "Not supported",
  not_supported: "Not supported",
  community: "Community supported",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** For an app: its latest Splunkbase release against the installed version, whether it is
 * archived, the Splunk versions it lists; for the catalogue app, the catalogue's numbers. */
export function SplunkbasePanel({ entity }: { entity: Entity }) {
  const p = (entity.properties ?? {}) as Record<string, unknown>;
  const sb = p.splunkbase as SplunkbaseFacts | undefined;
  const cat = p.splunkbaseCatalog as SplunkbaseCatalog | undefined;
  if (entity.type !== "app" || (!sb && !cat)) return null;
  const installed = typeof p.version === "string" ? p.version : undefined;
  return (
    <section>
      <h2>Splunkbase</h2>
      {sb && (
        <>
          <p>
            {sb.archived ? (
              <span className="status-label status-warning">Archived on Splunkbase: no longer maintained</span>
            ) : sb.updateAvailable ? (
              <span className="status-label status-warning">Newer version on Splunkbase: {sb.latestVersion}</span>
            ) : sb.updateAvailable === false ? (
              <span className="status-label status-good">Up to date with Splunkbase</span>
            ) : (
              <span className="muted">Splunkbase lists no release to compare with.</span>
            )}
          </p>
          <dl className="facts">
            <dt>Installed version</dt>
            <dd>{installed ?? <span className="muted">not known</span>}</dd>
            <dt>Latest on Splunkbase</dt>
            <dd>
              {sb.latestVersion ?? <span className="muted">no release</span>}
              {sb.releaseDate && <span className="muted"> · released {day(sb.releaseDate)}</span>}
            </dd>
            {sb.splunkVersions && (
              <>
                <dt>Splunk versions</dt>
                <dd>
                  {sb.splunkVersions.join(", ")}
                  {sb.compatible === false && (
                    <div className="muted small">This Splunk ({sb.splunkVersion}) is not among them: the release may not be tested with it.</div>
                  )}
                </dd>
              </>
            )}
            <dt>Splunk Cloud</dt>
            <dd>{sb.cloudCompatible ? "Compatible" : "Not marked compatible"}</dd>
            {sb.support && (<><dt>Support</dt><dd>{SUPPORT[sb.support] ?? sb.support}</dd></>)}
            <dt>On Splunkbase</dt>
            <dd>
              {sb.url ? (
                <><a href={sb.url} target="_blank" rel="noreferrer noopener">{sb.title ?? sb.appId}</a>{sb.uid ? <span className="muted"> · app {sb.uid}</span> : null}</>
              ) : (
                sb.title ?? sb.appId
              )}
            </dd>
            {sb.lastChecked && (
              <>
                <dt>Checked</dt>
                <dd title={new Date(sb.lastChecked).toLocaleString()}>{day(sb.lastChecked)}</dd>
              </>
            )}
          </dl>
        </>
      )}
      {cat && (
        <p>
          Its catalogue holds {(cat.apps ?? 0).toLocaleString()} Splunkbase app{cat.apps === 1 ? "" : "s"}:{" "}
          {(cat.installedHere ?? 0).toLocaleString()} installed here,{" "}
          <Link to="/findings?check=appUpdate">{(cat.updatesAvailable ?? 0).toLocaleString()} with a newer version</Link>,{" "}
          <Link to="/findings?check=appArchived">{(cat.archived ?? 0).toLocaleString()} archived</Link>.
          {cat.lastChecked ? (
            <span className="muted"> Last refreshed <span title={new Date(cat.lastChecked).toLocaleString()}>{day(cat.lastChecked)}</span>.</span>
          ) : (
            <span className="muted"> Not refreshed yet: enable its input.</span>
          )}
        </p>
      )}
    </section>
  );
}
