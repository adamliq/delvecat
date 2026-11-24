import { useState } from "react";
import type { CatalogBundle } from "../generated/catalog";
import { bytesToBase64, exportCatalog, importAgeDays, importCatalog, removeImported, STALE_IMPORT_DAYS, type ImportMode, type ImportSummary } from "../lib/transfer";

/** Export this stack's catalog, or import another stack's (a file, or read directly). */
export function TransferPanel({ bundle, canImport, inSplunk, onImported }: {
  bundle: CatalogBundle | null;
  canImport: boolean;
  inSplunk: boolean;
  onImported: () => void;
}) {
  const [from, setFrom] = useState<"stack" | "file">("stack");
  const [mode, setMode] = useState<ImportMode>("combine");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportSummary | null>(null);

  const imported = (bundle?.instances ?? []).filter((i) => i.imported);
  const doRemove = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from this stack's catalog? Import it again to bring it back.`)) return;
    setBusy("import");
    setError(null);
    try {
      await removeImported(id);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doExport = async () => {
    if (!bundle) return;
    setBusy("export");
    setError(null);
    try {
      await exportCatalog(bundle, inSplunk);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "replace" && !window.confirm("Replace this stack's catalog with the imported one? Its own objects will be gone until the next build.")) return;
    setBusy("import");
    setError(null);
    setDone(null);
    try {
      const summary = from === "file"
        ? await importCatalog({ source: "file", data: bytesToBase64(new Uint8Array(await file!.arrayBuffer())), filename: file!.name, mode })
        : await importCatalog({ source: "stack", url: url.trim(), token: token.trim(), verify, mode });
      setDone(summary);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setToken("");
    }
  };

  return (
    <section className="card transfer">
      <h2>Export and import</h2>
      <p className="muted small">
        Move a catalog between stacks, for example to see the Enterprise Security search head&apos;s objects on the ad
        hoc search head. <em>Combine</em> keeps this stack&apos;s catalog and adds the other one; importing the same
        stack again replaces its earlier copy, so a regular import keeps it current.
      </p>

      {imported.length > 0 && (
        <>
          <h3>Imported stacks</h3>
          <ul className="plain-list imported-list">
            {imported.map((i) => {
              const days = importAgeDays(i.imported?.at);
              const stale = days !== undefined && days > STALE_IMPORT_DAYS;
              return (
                <li key={i.id}>
                  <strong>{i.name ?? i.id}</strong>{" "}
                  <span className="muted small">
                    from {i.imported?.from?.replace(/^(stack|file) /, "") ?? "?"}
                    {days !== undefined && <>, {days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}</>}
                    {i.imported?.by && <> by {i.imported.by}</>}
                  </span>
                  {stale && <> <span className="status-label status-warning" title={`Imported stacks change only when imported again; this one is over ${STALE_IMPORT_DAYS} days old`}>! Not refreshed for {days} days</span></>}
                  {inSplunk && canImport && (
                    <> <button type="button" className="link-btn small" disabled={busy !== null} onClick={() => void doRemove(i.id, i.name ?? i.id)}>Remove</button></>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted small">They change only when imported again: import them regularly (below) to keep them current.</p>
        </>
      )}

      <h3>Export</h3>
      <p>
        <button type="button" className="btn" onClick={() => void doExport()} disabled={!bundle || busy !== null}>
          {busy === "export" ? "Preparing…" : "Download this catalog"}
        </button>{" "}
        <span className="muted small">A <code>.json.gz</code> file to import on another stack, or to open with <em>Open file</em>.</span>
      </p>

      <h3>Import</h3>
      {!inSplunk ? (
        <p className="muted small">Importing publishes to a stack, so it runs in the Splunk app.</p>
      ) : !canImport ? (
        <p className="notice">Importing needs the <code>delvecat_publisher</code> role (or admin).</p>
      ) : (
        <form className="testing-form" onSubmit={(e) => void doImport(e)}>
          <div className="seg" role="tablist" aria-label="Import from">
            <button type="button" role="tab" aria-selected={from === "stack"} className={from === "stack" ? "active" : undefined} onClick={() => setFrom("stack")}>From another stack</button>
            <button type="button" role="tab" aria-selected={from === "file"} className={from === "file" ? "active" : undefined} onClick={() => setFrom("file")}>From a file</button>
          </div>
          {from === "stack" ? (
            <>
              <label>
                <span>Stack address</span>
                <input type="text" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://es-mystack.splunkcloud.com:8089" autoComplete="off" spellCheck={false} />
                <span className="muted small">Its management port. Check it first on the Testing page if unsure.</span>
              </label>
              <label>
                <span>Token</span>
                <input type="password" required value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" spellCheck={false}
                  placeholder="A token of an account with delvecat_user there" />
                <span className="muted small">Used once to read its published catalog; not stored.</span>
              </label>
              <label className="sort"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Verify the TLS certificate</label>
            </>
          ) : (
            <label>
              <span>Catalog file</span>
              <input type="file" accept=".gz,.json,application/json,application/gzip" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <span className="muted small">A file from <em>Download this catalog</em> on the other stack, or from <code>delvecat-ingest</code> (not sharded).</span>
            </label>
          )}
          <fieldset className="transfer-mode">
            <legend>How</legend>
            <label className="sort"><input type="radio" name="mode" checked={mode === "combine"} onChange={() => setMode("combine")} /> Combine with this stack&apos;s catalog</label>
            <label className="sort"><input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace this stack&apos;s catalog</label>
          </fieldset>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy !== null || (from === "file" ? !file : !url.trim() || !token.trim())}>
              {busy === "import" ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {done && (
        <p className="notice" role="status">
          Imported from {done.source}: {done.before.toLocaleString()} → {done.after.toLocaleString()} objects, now {done.instances.map((i) => i.name).join(", ")}.
          {done.replacedInstances?.length ? ` Replaced the earlier copy of ${done.replacedInstances.join(", ")}.` : ""}
        </p>
      )}
    </section>
  );
}
