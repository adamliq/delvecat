import { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CatalogCtx } from "../lib/CatalogContext";
import { entityPath } from "../lib/routes";
import { DataTable } from "../components/DataTable";
import { canBuild } from "../lib/splunkBuild";
import { recentTargets, rememberTarget, testConnection, type ConnectivityResult, type StepResult } from "../lib/connectivity";
import { IN_SPLUNK } from "../lib/splunkSource";

const STATUS: Record<StepResult["status"], { cls: string; icon: string; label: string }> = {
  ok: { cls: "status-good", icon: "✓", label: "OK" },
  warning: { cls: "status-warning", icon: "!", label: "Warning" },
  failed: { cls: "status-critical", icon: "✕", label: "Failed" },
  skipped: { cls: "", icon: "–", label: "Skipped" },
};

function StepStatus({ s }: { s: StepResult["status"] }) {
  const x = STATUS[s];
  return <span className={x.cls ? `status-label ${x.cls}` : "muted"}>{x.icon} {x.label}</span>;
}

/** Testing: check that this Splunk can reach another stack with the app installed. */
/** Field filters that applied to whoever built the catalog: that build saw filtered data
 * and some commands were blocked for it. */
function FieldFilterCheck() {
  const ctx = useContext(CatalogCtx);
  if (ctx?.state.status !== "ready") return null;
  const filters = ctx.state.catalog.ofType("fieldFilter");
  if (!filters.length) return null;
  const hit = filters.filter((f) => (f.properties as { appliesToBuilder?: boolean } | undefined)?.appliesToBuilder);
  return (
    <section>
      <h2>Field filters and the catalog build</h2>
      {hit.length ? (
        <div className="notice">
          <p><strong>! {hit.length} field filter{hit.length === 1 ? "" : "s"} applied to the account that built this catalog.</strong>{" "}
            Its searches saw filtered data and Splunk blocks some commands for it, so the catalog may be missing objects or data.
            Exempt one of that account's roles from {hit.length === 1 ? "it" : "them"}, then build again.</p>
          <ul className="plain-list">{hit.map((f) => <li key={f.id}><Link to={entityPath(f.id)}>{f.name}</Link></li>)}</ul>
        </div>
      ) : (
        <p>✓ None of the {filters.length} field filter{filters.length === 1 ? "" : "s"} applied to the account that built this catalog.</p>
      )}
    </section>
  );
}

export function TestingPage() {
  const [url, setUrl] = useState(() => recentTargets()[0] ?? "");
  const [token, setToken] = useState("");
  const [verify, setVerify] = useState(true);
  const [timeout, setTimeoutSecs] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectivityResult | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(IN_SPLUNK ? null : false);
  const [recent, setRecent] = useState(recentTargets);

  useEffect(() => {
    if (IN_SPLUNK) canBuild().then(setAllowed).catch(() => setAllowed(false));
  }, []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await testConnection({ url: url.trim(), token: token.trim() || undefined, verify, timeout });
      setResult(r);
      setRecent(rememberTarget(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setToken(""); // used once; not kept
    }
  };

  return (
    <div className="stack">
      <div>
        <h1>Testing</h1>
        <p className="lede">Check that this Splunk can reach another stack that has Licoryx Delvecat installed, and that nothing limited the last build.</p>
      </div>

      <FieldFilterCheck />

      <section>
        <h2>Test connectivity to another stack</h2>
        <p className="muted small">
          This Splunk connects to the other stack's management port and checks, in order: the name resolves, the port
          answers, TLS is trusted, the token is accepted, the app is installed (and its version), and a catalog is
          published there. Every check only reads. The token is sent once for this test and is not stored.
        </p>
        {!IN_SPLUNK && (
          <p className="notice">The test runs from the Splunk app: open Licoryx Delvecat in Splunk to use it. A browser cannot reach another Splunk's management port itself.</p>
        )}
        {IN_SPLUNK && allowed === false && (
          <p className="notice">Only catalog publishers (the delvecat_publisher role) and admins can run connection tests.</p>
        )}
        <form className="testing-form" onSubmit={(e) => void run(e)}>
          <label>
            <span>Stack address</span>
            <input type="text" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://sh.example.com:8089"
              list="delvecat-recent-stacks" autoComplete="off" spellCheck={false} aria-describedby="testing-url-help" />
            <datalist id="delvecat-recent-stacks">{recent.map((r) => <option key={r} value={r} />)}</datalist>
            <span id="testing-url-help" className="muted small">The management port (8089 unless changed); on Splunk Cloud, https://&lt;stack&gt;.splunkcloud.com:8089.</span>
          </label>
          <label>
            <span>Token <span className="muted small">(optional)</span></span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" spellCheck={false}
              placeholder="An authentication token of an account on the other stack" aria-describedby="testing-token-help" />
            <span id="testing-token-help" className="muted small">Without one, only the network and TLS are checked. With delvecat_user there, the published catalog is checked too.</span>
          </label>
          <div className="testing-options">
            <label className="sort"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Verify the TLS certificate</label>
            <label className="sort">Wait up to
              <input type="number" min={2} max={30} value={timeout} onChange={(e) => setTimeoutSecs(Number(e.target.value) || 10)} className="input-seconds" /> seconds
            </label>
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy || !url.trim() || !IN_SPLUNK || allowed === false}>
              {busy ? "Testing…" : "Test connection"}
            </button>
          </div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {result && (
        <section aria-live="polite">
          <h2>
            {result.target}{" "}
            <span className={`status-label ${result.ok ? (result.steps.some((s) => s.status === "warning") ? "status-warning" : "status-good") : "status-critical"}`}>
              {result.ok ? (result.steps.some((s) => s.status === "warning") ? "! Reachable, with warnings" : "✓ Reachable") : "✕ Not reachable"}
            </span>
          </h2>
          {result.checkedAt && <p className="muted small">Checked {new Date(result.checkedAt).toLocaleString()}.</p>}
          <DataTable
            rows={result.steps}
            rowKey={(s) => s.step}
            columns={[
              { label: "Check", value: (s) => s.title, noSort: true },
              { label: "Result", value: (s) => s.status, noSort: true, render: (s) => <StepStatus s={s.status} /> },
              { label: "Detail", value: (s) => s.message, noSort: true, render: (s) => (s.generatedAt ? s.message.replace(s.generatedAt, new Date(s.generatedAt).toLocaleString()) : s.message) },
              { label: "Time", value: (s) => s.ms ?? -1, noSort: true, render: (s) => (s.ms !== undefined ? `${s.ms.toLocaleString()} ms` : "") },
            ]}
          />
        </section>
      )}
    </div>
  );
}
