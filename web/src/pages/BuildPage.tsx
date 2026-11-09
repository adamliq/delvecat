import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCatalogState } from "../lib/CatalogContext";
import {
  type BuildOptions,
  type BuildStatus,
  cancelBuild,
  canBuild,
  jobState,
  readBuildStatus,
  startBuild,
} from "../lib/splunkBuild";
import { readPointer, type Pointer } from "../lib/splunkSource";

const POLL_MS = 2000;
const SPLUNK_KINDS = new Set(["splunkEnterprise", "splunkCloud"]);

function when(iso?: string) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function seconds(from?: string, to?: string) {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Build the catalog of this Splunk on demand (Splunk app only). */
export function BuildPage() {
  const { state, reload } = useCatalogState();
  const bundle = state.status === "ready" ? state.catalog.bundle : null;
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState<BuildOptions>({
    fields: false,
    usage: true,
    redact: "none",
    instance: "",
    instanceName: "",
  });
  const prefilled = useRef(false);
  // The search this page started: followed until it ends, whatever the status says.
  const watch = useRef<{ sid: string; startedAt: string } | null>(null);
  const [watching, setWatching] = useState(false);
  const reloadedFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([readBuildStatus(), readPointer().catch(() => null)]);
    // A "running" status whose search is gone was cancelled or died.
    if (s?.state === "running") {
      const job = await jobState(s.sid).catch(() => null);
      if (!job || job.isDone || job.isFailed) {
        s.state = "failed";
        s.message = job?.messages.join("; ") || "The build's search ended before it finished (cancelled?).";
      }
    }
    const w = watch.current;
    if (w && s?.sid === w.sid && s.state !== "running") {
      watch.current = null; // ours, and finished
    } else if (w && s?.sid !== w.sid) {
      // Not (yet) reported by our build: starting, or it failed before writing a status.
      const job = await jobState(w.sid).catch(() => null);
      if (!job || job.isDone || job.isFailed) {
        watch.current = null;
        setError(job?.messages.join("; ") || "The build ended without reporting. See the search in Splunk's Jobs.");
      } else {
        setStatus({ state: "running", sid: w.sid, user: "you", startedAt: w.startedAt, updatedAt: w.startedAt, step: "starting" });
        setPointer(p);
        setWatching(true);
        return s;
      }
    }
    setWatching(!!watch.current);
    setStatus(s);
    setPointer(p);
    return s;
  }, []);

  useEffect(() => {
    void canBuild().then(setAllowed);
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  // Same instance id as the catalog being replaced, so versions and "first seen" carry over.
  useEffect(() => {
    if (prefilled.current || (!status && !bundle)) return;
    prefilled.current = true;
    const fromCatalog = bundle?.instances.find((i) => SPLUNK_KINDS.has(String(i.kind)));
    setOpts((o) => ({
      ...o,
      fields: status?.options?.fields ?? o.fields,
      usage: status?.options?.usage ?? o.usage,
      redact: (status?.options?.redact as BuildOptions["redact"]) ?? o.redact,
      instance: status?.instance ?? fromCatalog?.id ?? "",
      instanceName: fromCatalog?.name && fromCatalog.name !== fromCatalog.id ? fromCatalog.name : "",
    }));
  }, [status, bundle]);

  const running = status?.state === "running";
  useEffect(() => {
    if (!running && !watching) return;
    const t = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [running, watching, refresh]);

  // Show the new catalog as soon as a build finishes.
  useEffect(() => {
    if (status?.state === "done" && !status.dryRun && reloadedFor.current !== status.sid) {
      if (reloadedFor.current !== null) void reload();
      reloadedFor.current = status.sid;
    }
  }, [status, reload]);

  const start = async (replaceSmaller = false) => {
    setError(null);
    setBusy(true);
    try {
      reloadedFor.current = reloadedFor.current ?? "";
      const sid = await startBuild({ ...opts, webUrl: window.location.origin, replaceSmaller });
      watch.current = { sid, startedAt: new Date().toISOString() };
      setWatching(true);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const others = (bundle?.instances ?? []).filter((i) => i.id !== (opts.instance || status?.instance));
  const skipped = (status?.problems ?? []).filter((p) => p.status === "skipped");
  const failed = (status?.problems ?? []).filter((p) => p.status !== "skipped");

  return (
    <div className="stack">
      <h1>Build the catalog</h1>
      <p className="muted">
        Reads this Splunk&apos;s configuration and usage with <strong>your</strong> permissions (read-only) and
        publishes the catalog to this app for everyone with the <code>delvecat_user</code> role. It runs as a
        Splunk search, usually in under a minute.
      </p>

      <section className="card">
        <h2>Current catalog</h2>
        {bundle ? (
          <p>
            {bundle.entities.length.toLocaleString()} objects across {bundle.instances.length} instance
            {bundle.instances.length === 1 ? "" : "s"} ({bundle.instances.map((i) => i.name).join(", ")}).
            {pointer?.publishedAt && (
              <>
                {" "}
                Published {when(pointer.publishedAt)}
                {pointer.publishedBy && <> by {pointer.publishedBy}</>}.
              </>
            )}
          </p>
        ) : (
          <p className="muted">No catalog has been published yet.</p>
        )}
      </section>

      {allowed === false && (
        <p className="notice">
          Building needs the <code>delvecat_publisher</code> role (or admin). Ask a Splunk admin, or have the
          catalog built and published with <code>delvecat-ingest publish</code>.
        </p>
      )}

      {allowed && (
        <section className="card build-form">
          <h2>Options</h2>
          <label>
            Instance id{" "}
            <input
              value={opts.instance}
              placeholder="this Splunk's server name"
              pattern="[A-Za-z0-9_-]+"
              onChange={(e) => setOpts({ ...opts, instance: e.target.value })}
              disabled={running}
            />{" "}
            <span className="muted">keep it the same between builds</span>
          </label>
          <label>
            Name{" "}
            <input
              value={opts.instanceName}
              placeholder="e.g. Production search head"
              onChange={(e) => setOpts({ ...opts, instanceName: e.target.value })}
              disabled={running}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.fields}
              onChange={(e) => setOpts({ ...opts, fields: e.target.checked })}
              disabled={running}
            />{" "}
            Discover fields by sampling events (slower; powers schemas, field lineage and quality checks)
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.usage}
              onChange={(e) => setOpts({ ...opts, usage: e.target.checked })}
              disabled={running}
            />{" "}
            Usage and health from <code>_internal</code> and <code>_audit</code>
          </label>
          <label>
            Redaction{" "}
            <select
              value={opts.redact}
              onChange={(e) => setOpts({ ...opts, redact: e.target.value as BuildOptions["redact"] })}
              disabled={running}
            >
              <option value="none">none</option>
              <option value="internal">internal: drop personal names</option>
            </select>
          </label>
          {others.length > 0 && (
            <p className="notice">
              The current catalog also has {others.map((i) => i.name).join(", ")}. A build here replaces it with
              this Splunk only. To keep several instances, build them outside Splunk and publish the merged
              catalog.
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void start(false)} disabled={busy || running}>
              {running ? "Building…" : busy ? "Starting…" : "Build now"}
            </button>
            {running && status && (
              <button type="button" className="btn" onClick={() => void cancelBuild(status.sid).then(refresh)}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {status && (
        <section className="card" aria-live="polite">
          <h2>
            {running
              ? "Building"
              : status.state === "done"
                ? "Last build"
                : status.reason === "smaller"
                  ? "Last build was not published"
                  : "Last build failed"}
          </h2>
          {running && (
            <p>
              <strong>{status.step}</strong> · started by {status.user} {seconds(status.startedAt)} ago
            </p>
          )}
          {status.state === "done" && (
            <>
              <p>
                {status.dryRun ? "Dry run: " : ""}
                {status.entities?.toLocaleString()} objects and {status.edges?.toLocaleString()} relationships
                from <code>{status.instance}</code>, built by {status.user} on {when(status.finishedAt)} in{" "}
                {seconds(status.startedAt, status.finishedAt)}. <Link to="/">Open the catalog</Link>
              </p>
              {failed.length > 0 && (
                <>
                  <p className="error">Some parts could not be read:</p>
                  <ul>
                    {failed.map((p) => (
                      <li key={p.connector}>
                        <code>{p.connector}</code> {p.status}: {p.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {skipped.length > 0 && (
                <details>
                  <summary className="muted">
                    {skipped.length} skipped (products not installed, or not visible to {status.user})
                  </summary>
                  <ul>
                    {skipped.map((p) => (
                      <li key={p.connector}>
                        <code>{p.connector}</code>: {p.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {status.state === "failed" && status.reason === "smaller" && (
            <div className="notice">
              <p>
                <strong>Not published.</strong> This build found {status.entities?.toLocaleString()} objects (not counting fields); the
                current catalog has {status.previousEntities?.toLocaleString()}. {status.user} probably sees less of
                this Splunk than whoever built the current one, so publishing would hide objects from everyone.
              </p>
              <p>Build as an admin, or replace the catalog anyway.</p>
              {allowed && (
                <button type="button" className="btn" onClick={() => void start(true)} disabled={busy || running}>
                  Build and replace anyway
                </button>
              )}
            </div>
          )}
          {status.state === "failed" && status.reason !== "smaller" && (
            <p className="error">
              {status.message} (started by {status.user} on {when(status.startedAt)}, search{" "}
              <code>{status.sid}</code>)
            </p>
          )}
        </section>
      )}
    </div>
  );
}
