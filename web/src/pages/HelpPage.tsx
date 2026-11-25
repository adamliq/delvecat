import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useCatalog } from "../lib/CatalogContext";
import { IN_SPLUNK } from "../lib/splunkSource";

interface Section {
  id: string;
  title: string;
  /** Extra words to find the section by (synonyms people might search for). */
  keywords?: string;
  body: ReactNode;
}

const L = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to}>{children}</Link>;

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Getting started",
    keywords: "overview introduction what is",
    body: (
      <>
        <p>
          Licoryx Delvecat is a read-only catalog of a Splunk deployment: its indexes, sourcetypes, fields, searches,
          detections, dashboards, inputs, roles, apps and more, with how they connect (lineage), how they are used, and
          what is wrong with them (health). It never changes Splunk.
        </p>
        <ul>
          <li>Find anything with the search box at the top, or <L to="/search">Browse</L> by type, app, owner and more.</li>
          <li>Open an object to see its properties, lineage (what feeds it, what it feeds), relationships and usage.</li>
          <li>Start the day on <L to="/">Home</L>: its "At a glance" tiles link to what needs attention.</li>
        </ul>
      </>
    ),
  },
  {
    id: "pages",
    title: "The pages",
    keywords: "menu navigation browse domains schemas glossary coverage findings health governance insights sql testing palette keyboard shortcut stack",
    body: (
      <>
      <p>
        The menu bar groups the pages into <strong>Explore</strong>, <strong>Quality and risk</strong> and <strong>Analyse</strong>.
        Press <kbd>/</kbd> to jump to the search box (it suggests objects as you type) and <kbd>Ctrl</kbd> <kbd>K</kbd> (<kbd>⌘</kbd> <kbd>K</kbd> on a Mac)
        to go to any page or object by name. <em>Built … ago</em> links to what changed, with a dot when a build has
        been published since you last looked. With several stacks, the stack picker limits every page to one of them.
        In Splunk, <em>Admin</em> (catalog publishers and admins) holds Build and Testing; elsewhere, <em>Load catalog</em> opens a file or folder.
      </p>
      <dl className="help-defs">
        <dt><L to="/">Home</L></dt><dd>Instances, at-a-glance tiles, documentation coverage and every object type by area.</dd>
        <dt><L to="/search">Browse</L></dt><dd>Search and filter everything, including lookups and data models by the fields they hold (<em>Has field</em> filters lookups, collections, data models and sourcetypes by field name; <em>Runs command</em> filters searches by the commands they run; built-in time ranges, chart types and settings are left out unless you ask for them). Results say why they matched; <em>Table</em> shows them as a sortable table; <em>Download CSV</em> exports them.</dd>
        <dt><L to="/domains">Domains</L></dt><dd>Business areas and the data products they deliver, with how well each is documented and its problems.</dd>
        <dt><L to="/schemas">Schemas</L></dt><dd>Field schemas of sampled sourcetypes, lookups and KV Store collections (a data model's own page lists its datasets, field types, calculations and the searches naming each dataset), their CIM data model coverage, and fields shared across them. <L to="/compare">Compare</L> puts sourcetypes, lookups and data models side by side.</dd>
        <dt><L to="/glossary">Glossary</L></dt><dd>Business terms, the objects and fields they describe, and unused terms.</dd>
        <dt><L to="/coverage">Coverage</L></dt><dd>MITRE ATT&amp;CK and CIM coverage of your detections, and what would let detections that cannot fire work.</dd>
        <dt><L to="/findings">Findings</L></dt><dd>Every warning and critical check in one list, with how to fix each.</dd>
        <dt><L to="/health">Health</L></dt><dd>Findings by area, the trend over builds, who needs to act, what was fixed, and the cleanup report of unused objects. Accept or snooze findings here.</dd>
        <dt><L to="/governance">Governance</L></dt><dd>Where sensitive data lives, how it spreads through lineage, and which roles, users and groups can reach it; and the high-risk capabilities with the roles and users holding them. Role and user pages list their capabilities; each capability page says who holds it.</dd>
        <dt><L to="/changes">Changes</L></dt><dd>What changed in Splunk since the previous build: added, removed and modified objects, with each changed setting before and after.</dd>
        <dt><L to="/insights">Insights</L></dt><dd>Documentation and ownership targets with worklists, distributions, what is used most, and every command searches run (risky ones marked; each command has a page listing the searches that run it).</dd>
        <dt><L to="/sql">SQL</L></dt><dd>Query the catalog with SQLite in your browser (read-only), with examples, history and charts.</dd>
        <dt><L to="/testing">Testing</L></dt><dd>Check that this Splunk can reach another stack that has the app installed.</dd>
        <dt><L to="/properties">Properties</L></dt><dd>Structured properties your team defines (retention tier, compliance scope...) and how much of the catalog has them.</dd>
      </dl>
      </>
    ),
  },
  {
    id: "objects",
    title: "Object pages",
    keywords: "entity lineage relationships tabs spl fields annotations raw",
    body: (
      <ul>
        <li><strong>Overview</strong>: product, instance, app, owner and status; health and usage; storage (for indexes); the SPL with the objects it names linked; every property in plain words. "On this page" jumps to a section.</li>
        <li><strong>Lineage</strong>: what feeds the object and what it feeds, as a graph; broken references are marked.</li>
        <li><strong>Fields</strong>: for sourcetypes, the field schema; for searches, the fields they use.</li>
        <li><strong>Relationships</strong>: every connection, as a graph or a list.</li>
        <li><strong>Annotations</strong>: descriptions, owners, tags, classifications and terms added by your team, and how to add them.</li>
        <li><strong>Raw</strong>: the object exactly as the catalog stores it.</li>
        <li>An "At risk" banner means something the object depends on has a problem, so it may be missing data or failing.</li>
      </ul>
    ),
  },
  {
    id: "health",
    title: "Health, findings and acknowledging",
    keywords: "stale skipped failed noisy alert token retention acknowledge accept snooze trend fixed",
    body: (
      <>
        <p>
          Each build checks data freshness and volume, ingestion delay, parsing, skipped and failed scheduled searches,
          noisy alerts, forwarders, HTTP Event Collector, retention by size, routing, acceleration, ES suppressions and
          authentication tokens. The thresholds used are listed at the top of the <L to="/health">Health</L> page.
        </p>
        <ul>
          <li><strong>How to fix</strong> under a finding says why it matters, what to do, and gives a search to investigate (<em>Open in Splunk search</em> or <em>Copy search</em>).</li>
          <li><strong>Acknowledge</strong>: accept a finding (known, not fixing) or snooze it for 7, 30 or 90 days with a note. It is hidden until the snooze ends or it gets worse. In Splunk, catalog publishers and admins can acknowledge, and everyone sees who did and why; elsewhere it is kept in your browser.</li>
          <li><strong>New and fixed</strong>: each build is compared with the previous one, so findings show when they were first seen, and those that went away are listed as fixed.</li>
          <li>Ages ("6 hours ago") count from when the catalog was measured, not from today.</li>
        </ul>
      </>
    ),
  },
  {
    id: "build",
    title: "Building and publishing the catalog",
    keywords: "build publish delvecatbuild parts refresh update schedule cli delvecat-ingest powershell",
    body: (
      <>
        <p>The catalog is a snapshot: it changes only when someone builds it again.</p>
        <ul>
          <li><strong>In Splunk</strong>: the <em>Build</em> button (catalog publishers and admins) reads this Splunk with your permissions and publishes the result. Choose the parts to read, field discovery and a search time limit. A build that would replace the catalog with a much smaller one asks first. To refresh it regularly, turn on the <em>Schedule</em> on the Build page (daily, weekly or a cron expression); it builds with the parts and options chosen there.</li>
          <li><strong>Outside Splunk</strong>: <code>delvecat-ingest build</code> (or <code>scripts/Build-Catalog.ps1</code>) then <code>delvecat-ingest publish</code>. Use it to combine several instances (indexers, Deployment Server, SOAR, UBA), apply annotations from a repository, or redact a catalog for public use.</li>
          <li>Outside Splunk you can also open a catalog with <em>Open file</em> or <em>Open folder</em>.</li>
        </ul>
      </>
    ),
  },
  {
    id: "transfer",
    title: "Moving a catalog between stacks",
    keywords: "export import download upload combine replace es enterprise security ad hoc search head another stack",
    body: (
      <>
        <p>
          On the Build page, <em>Export and import</em>: <em>Download this catalog</em> saves it as a <code>.json.gz</code>
          file. <em>Import</em> (catalog publishers and admins) takes such a file, or reads the catalog straight from
          another stack that has the app, with its management address and a token of an account with
          <code> delvecat_user</code> there (read-only; the token is used once and not stored).
        </p>
        <ul>
          <li><strong>Combine</strong> keeps this stack&apos;s catalog and adds the other one, e.g. the ES search head&apos;s objects on the ad hoc search head. Importing the same stack again replaces its earlier copy.</li>
          <li><strong>Replace</strong> publishes the imported catalog alone.</li>
          <li>A build here keeps imported stacks and replaces only this stack&apos;s own part; import again to refresh them. The Build page lists them, flags any not refreshed for over a week, and can remove one.</li>
          <li>With several stacks, Health and Findings filter by stack, Insights groups by stack, and each object page shows its stack.</li>
        </ul>
      </>
    ),
  },
  {
    id: "roles",
    title: "Roles and who sees what",
    keywords: "permissions access delvecat_user delvecat_publisher admin sc_admin",
    body: (
      <>
        <table className="mini-table">
          <thead><tr><th>Role</th><th>Can</th></tr></thead>
          <tbody>
            <tr><td><code>delvecat_user</code></td><td>Open the app and read the catalog.</td></tr>
            <tr><td><code>delvecat_publisher</code></td><td>Also build, import and publish the catalog, accept or snooze findings, and run connection tests.</td></tr>
            <tr><td><code>admin</code>, <code>sc_admin</code></td><td>Everything.</td></tr>
          </tbody>
        </table>
        <p>
          Everyone who can open the app sees the whole catalog, including objects their own Splunk permissions hide.
          Give the role accordingly, or publish a redacted catalog.
        </p>
      </>
    ),
  },
  {
    id: "privacy",
    title: "What is collected, and what never is",
    keywords: "privacy secrets passwords tokens security read-only redaction pii",
    body: (
      <>
        <p>
          Licoryx Delvecat reads configuration and usage over Splunk's REST API and searches, read-only. The only things it
          writes are inside its own app: the published catalog, the build status, and accepted or snoozed findings. Its own
          searches are marked so usage reports leave them out.
        </p>
        <p><strong>Never collected:</strong> passwords, token values, HEC token values, client secrets, certificates and keys,
          <code>pass4SymmKey</code>, LDAP bind credentials and member names, connection credentials, and the values of add-on
          and modular input settings (their names only). The most-run ad-hoc searches (up to 1,000, typed at the search bar or sent over the REST API) are kept as Ad-hoc Search objects with their SPL, run and user counts, and the objects they read; who ran them is not kept. Building with the public redaction profile drops the SPL. For lookup files no definition describes, only the field names of the header row are read, never values.</p>
        <p>The <em>internal</em> redaction profile drops real names; the <em>public</em> one also pseudonymises users and hosts and drops URLs, IP addresses and customer identifiers.</p>
      </>
    ),
  },
  {
    id: "annotations",
    title: "Adding descriptions, owners and terms",
    keywords: "annotations yaml owners tags classifications glossary domains data products structured properties",
    body: (
      <p>
        Business metadata lives in YAML files in an <code>annotations/</code> folder (usually a Git repository): descriptions,
        owning teams, tags, classifications, glossary terms, domains, data products and structured properties. Builds and
        merges outside Splunk apply them with <code>--annotations</code>. An object's <em>Annotations</em> tab shows the
        snippet to add and, when the folder is in a repository, a link to suggest the edit.
      </p>
    ),
  },
  {
    id: "sql",
    title: "SQL console",
    keywords: "query sqlite tables json_extract examples chart export",
    body: (
      <ul>
        <li>Tables include <code>entities</code>, <code>edges</code>, <code>settings</code>, <code>health_checks</code>, <code>labels</code>, <code>access</code> and more; the <em>Tables</em> tab lists them with their columns.</li>
        <li>Ctrl+Enter runs the query; Tab completes table and column names; <em>Format</em> lays it out.</li>
        <li>A result of a label and a number can be shown as a chart. Results download as CSV; <em>Copy link</em> shares the query.</li>
        <li>It runs in your browser on the loaded catalog and cannot change anything.</li>
      </ul>
    ),
  },
  {
    id: "testing",
    title: "Testing connectivity to another stack",
    keywords: "connection network firewall tls certificate token allow list acs",
    body: (
      <>
        <p>
          On the <L to="/testing">Testing</L> page, give another stack's management address (<code>https://host:8089</code>)
          and, optionally, a token of an account there. This Splunk checks the name, the port, TLS, the token, that the app is
          installed (and its version), and that a catalog is published. Each failure names the likely cause. The token is used
          once and not stored. Catalog publishers and admins only.
        </p>
        <p>On Splunk Cloud, the other stack's search-api allow list (ACS) must include this stack's outbound IP addresses.</p>
      </>
    ),
  },
  {
    id: "urls",
    title: "Sharing a view",
    keywords: "link url bookmark filters share",
    body: (
      <p>
        Filters are kept in the address on Browse, Findings, Health, Insights, Schemas, Coverage, Governance, Glossary,
        Compare and SQL, so copying the address shares exactly what you see. Tables sort by any column (click its header)
        and download as CSV.
      </p>
    ),
  },
  {
    id: "handy",
    title: "Handy things",
    keywords: "theme dark light print pdf copy recent back keyboard",
    body: (
      <ul>
        <li><strong>Theme</strong>: at the bottom of every page. Automatic follows your Splunk theme (or your system outside Splunk).</li>
        <li><strong>Recently viewed</strong> objects are on Home; an object opened from a search has <em>Back to results</em>.</li>
        <li><strong>Copy</strong>: object pages copy their id or link; SPL has a <em>Copy</em> button.</li>
        <li><strong>Print report</strong> on Health and Findings prints, or saves as PDF, every row with each finding&apos;s advice.</li>
      </ul>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    keywords: "error problem missing empty not found access denied stale",
    body: (
      <dl className="help-defs">
        <dt>"You do not have access to the catalog"</dt>
        <dd>Ask a Splunk admin for the <code>delvecat_user</code> role.</dd>
        <dt>The catalog is empty or out of date</dt>
        <dd>Someone with <code>delvecat_publisher</code> builds it with <em>Build</em>; the footer says when it was generated.</dd>
        <dt>Something you expect is missing</dt>
        <dd>The catalog holds what the builder could see. Check the parts that were read on <L to="/">Home</L> ("What this catalog covers"), and whether the builder's roles see that app or index.</dd>
        <dt>A part was skipped or failed</dt>
        <dd>Home lists each part with why. Products that are not installed are skipped; a failed part is usually a permission or a timeout (raise the search time limit).</dd>
        <dt>The page is from an older version after an upgrade</dt>
        <dd>Reload the page; if it persists, an admin opens <code>/en-US/_bump</code> in Splunk Web once.</dd>
        <dt>The connection test endpoint is not available</dt>
        <dd>Restart Splunk after installing or upgrading the app.</dd>
      </dl>
    ),
  },
];

/** Help: what each page does, roles, building, privacy and troubleshooting, searchable. */
export function HelpPage() {
  const { catalog } = useCatalog();
  const { hash } = useLocation();
  const [q, setQ] = useState("");
  const refs = useRef(new Map<string, HTMLElement>());
  const [texts, setTexts] = useState<Map<string, string>>(new Map());

  // Section text for the search box, read once from what is rendered.
  useEffect(() => {
    setTexts(new Map(SECTIONS.map((s) => [s.id, `${s.title} ${s.keywords ?? ""} ${refs.current.get(s.id)?.textContent ?? ""}`.toLowerCase()])));
  }, []);
  // Links like #/help#health (or /help?section=health) open at that section.
  useEffect(() => {
    const id = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section") ?? hash.replace(/^#/, "");
    if (id) refs.current.get(id)?.scrollIntoView({ block: "start" });
  }, [hash]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(
    () => new Set(SECTIONS.filter((s) => !words.length || words.every((w) => (texts.get(s.id) ?? s.title.toLowerCase()).includes(w))).map((s) => s.id)),
    [words.join(" "), texts], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const go = (id: string) => refs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const gen = catalog.bundle.generator;

  return (
    <div className="stack">
      <div>
        <h1>Help</h1>
        <p className="lede">How to use Licoryx Delvecat: the pages, roles, building the catalog, privacy and troubleshooting.</p>
      </div>
      <div className="help-layout">
        <nav className="help-toc" aria-label="Help topics">
          <input type="search" placeholder="Search help" aria-label="Search help" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="plain-list">
            {SECTIONS.map((s) => (
              <li key={s.id} hidden={!shown.has(s.id)}>
                <button type="button" className="link-btn" onClick={() => go(s.id)}>{s.title}</button>
              </li>
            ))}
          </ul>
          {words.length > 0 && shown.size === 0 && <p className="muted small">Nothing matches "{q}".</p>}
        </nav>
        <div className="help-body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={`help-${s.id}`} ref={(el) => { if (el) refs.current.set(s.id, el); }} hidden={!shown.has(s.id)} className="help-section">
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
          <section className="help-section">
            <h2>About this catalog</h2>
            <p className="small">
              Built {new Date(catalog.bundle.generatedAt).toLocaleString()} by {gen?.name ?? "delvecat-ingest"} {gen?.version ?? ""}
              {" · "}{catalog.bundle.entities.length.toLocaleString()} objects from {catalog.bundle.instances.length} instance{catalog.bundle.instances.length === 1 ? "" : "s"}
              {IN_SPLUNK ? " · shown in the Splunk app" : ""}.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
