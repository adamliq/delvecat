// End-to-end test of the Licoryx Delvecat Splunk app against a disposable test Splunk.
//
// It builds, cancels and replaces the app's catalog, so never point it at a Splunk
// that matters. Setup (see splunk-app/README.md, "Testing"): the app installed, the
// roles delvecat_user and delvecat_publisher, and the users admin, viewer
// (user + delvecat_user), publisher (user + delvecat_publisher) and plain (user),
// with the passwords below. Run from web/ (for Playwright):
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node ../splunk-app/test/e2e.cjs \
//     http://localhost:8000 https://localhost:8089 [section,...]
// The TLS override is for the test Splunk's self-signed certificate only.
const { chromium } = require('playwright');
const WEB = process.argv[2] || 'http://localhost:8000';
const MGMT = process.argv[3] || 'https://localhost:8089';
const ONLY = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
const USERS = {
  admin: 'DevPass-1234!', viewer: 'Viewer-1234!', publisher: 'Publish-1234!', plain: 'Plain-1234!',
};
const KV = '/servicesNS/nobody/delvecat/storage/collections/data/delvecat_catalog';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(method, path, user = 'admin', form) {
  const headers = { Authorization: 'Basic ' + Buffer.from(`${user}:${USERS[user]}`).toString('base64') };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ ...form, output_mode: 'json' }).toString();
  }
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${MGMT}${path}${method === 'GET' ? sep + 'output_mode=json' : ''}`, { method, headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const buildDoc = async () => (await rest('GET', `${KV}/build`)).json;
const pointer = async () => (await rest('GET', `${KV}/current`)).json;

/** Wait until the build document belongs to a new search and is no longer running. */
async function waitBuild(prevSid, timeoutMs = 240000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const d = await buildDoc();
    if (d && d.sid !== prevSid && d.state !== 'running') return d;
    await sleep(1500);
  }
  return null;
}

async function oneshot(search, user = 'admin') {
  const r = await rest('POST', `/servicesNS/${user}/delvecat/search/jobs`, user, { search, exec_mode: 'oneshot' });
  return r.json || { text: r.text };
}

let browser;
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${WEB}/en-US/account/login`);
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', USERS[user]);
  await page.click('input[type=submit]');
  await page.waitForURL(/app\/launcher/, { timeout: 90000 });
  return { page, errors, close: () => ctx.close() };
}
const app = (hash = '') => `${WEB}/en-US/app/delvecat/catalog${hash}`;
const mainText = async (page) => (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');

async function uiBuild(page, { setup, replaceAnyway } = {}) {
  const prev = (await buildDoc())?.sid;
  await page.goto(app('#/build'));
  await page.waitForSelector('fieldset.parts', { timeout: 30000 });
  await sleep(1500);
  if (setup) await setup(page);
  await page.click(replaceAnyway ? 'button:has-text("Build and replace anyway")' : 'button:has-text("Build now")');
  const doc = await waitBuild(prev);
  await sleep(2500); // the page polls every 2 s
  return doc;
}

const sections = {
  async access() {
    const plain = await session('plain');
    await plain.page.goto(app());
    await sleep(3000);
    check('user without delvecat_user does not get the app', /not available|App not found/i.test(await plain.page.locator('body').innerText()));
    await plain.close();
    const r = await oneshot('| delvecatbuild dryrun=true', 'viewer');
    const msg = JSON.stringify(r.messages || r);
    check('viewer cannot run | delvecatbuild', /Unknown search command|not found|permission/i.test(msg), msg.slice(0, 120));
    const w = await rest('POST', `${KV}/batch_save`, 'viewer');
    check('viewer cannot write the catalog collection', w.status >= 400, `HTTP ${w.status}`);
  },

  async empty() {
    const v = await session('viewer');
    await v.page.goto(app());
    await v.page.waitForSelector('h1');
    await sleep(2000);
    const vt = await mainText(v.page);
    check('viewer, no catalog: "No catalog loaded" shown', vt.includes('No catalog loaded'));
    check('viewer has no Build button', (await v.page.locator('.open-buttons a:has-text("Build")').count()) === 0);
    await v.page.goto(app('#/build'));
    await sleep(2500);
    check('viewer on the Build page is told the role it needs', (await mainText(v.page)).includes('Building needs the delvecat_publisher role'));
    check('viewer pages without script errors', v.errors.length === 0, v.errors.join('; '));
    await v.close();
    const a = await session('admin');
    await a.page.goto(app());
    await a.page.waitForSelector('h1');
    await sleep(2000);
    check('admin, no catalog: Build button in the header', (await a.page.locator('.open-buttons a:has-text("Build")').count()) === 1);
    await a.page.click('text=Build the catalog of this Splunk');
    await a.page.waitForSelector('fieldset.parts', { timeout: 20000 });
    const all = await a.page.locator('.parts-all').innerText();
    check('Build page opens from the empty state, default 64 of 65 parts', /64 of 65/.test(all), all.trim());
    await a.close();
  },

  async build() {
    const a = await session('admin');
    // The page starts from the previous build's parts (by design); with none, the default.
    const prevParts = (await buildDoc())?.options?.parts;
    const expected = prevParts ? prevParts.length : 64;
    const t0 = Date.now();
    const doc = await uiBuild(a.page);
    check('default build from the page finishes and publishes', doc?.state === 'done' && !doc.dryRun,
      `${doc?.entities} objects, ${doc?.edges} relationships in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    check(`build ran the page's starting selection (${expected} parts)`,
      doc?.options?.parts?.length === expected && (!!prevParts || !doc.options.parts.includes('fields')));
    const problems = (doc?.problems || []).filter((p) => p.status !== 'skipped');
    check('no part failed', problems.length === 0, problems.map((p) => p.connector + ': ' + p.message).join('; '));
    const text = await mainText(a.page);
    check('page shows the result and reloads the catalog', text.includes('Last build') && text.includes(`${doc?.entities?.toLocaleString('en-US')} objects`));
    const p = await pointer();
    check('pointer names admin as publisher', p?.publishedBy === 'admin', p?.generation);
    check('page errors', a.errors.length === 0, a.errors.join('; '));
    await a.close();
  },

  async browse() {
    const v = await session('viewer');
    const visit = async (hash, wait, name, test) => {
      await v.page.goto(app(hash));
      try { await v.page.waitForSelector(wait, { timeout: 30000 }); } catch {}
      await sleep(1500);
      const t = await mainText(v.page);
      check(`viewer: ${name}`, test(t), t.slice(0, 90));
    };
    await visit('', 'h1', 'home shows the catalog', (t) => /Catalog overview/.test(t) && /objects/.test(t));
    await visit('#/search?q=_internal', 'main', 'search finds _internal', (t) => /_internal/.test(t));
    await visit('#/search?type=savedSearch', 'main', 'browse saved searches', (t) => /saved search/i.test(t));
    // open an index's page
    await v.page.goto(app('#/search?q=_internal&type=index'));
    await sleep(2000);
    const link = v.page.locator('main a[href*="entity/"]').first();
    if (await link.count()) {
      await link.click();
      await sleep(2000);
      const t = await mainText(v.page);
      check('viewer: object page opens (index _internal)', /_internal/.test(t) && /(Lineage|Relationships|Overview)/i.test(t), t.slice(0, 80));
    } else check('viewer: object page opens (index _internal)', false, 'no link');
    await visit('#/schemas', 'h1', 'Schemas page', (t) => /Schema/i.test(t));
    await visit('#/coverage', 'h1', 'Coverage page', (t) => /coverage/i.test(t));
    await visit('#/health', 'h1', 'Health page', (t) => /health/i.test(t));
    await visit('#/findings', 'h1', 'Findings page', (t) => /Findings/.test(t) && /critical/.test(t));
    await visit('', 'h1', 'home says what the catalog covers', (t) => /What this catalog covers/.test(t) && /\d+ read/.test(t));
    await visit('#/governance', 'h1', 'Governance page', (t) => /Governance/i.test(t));
    await visit('#/insights', 'h1', 'Insights page', (t) => /Insights/i.test(t));
    await v.page.goto(app('#/sql'));
    await v.page.waitForSelector('button:has-text("Run")', { timeout: 30000 });
    await sleep(2000);
    await v.page.locator('textarea').fill("SELECT type, count(*) AS n FROM entities GROUP BY type ORDER BY n DESC");
    await v.page.click('button:has-text("Run")');
    try { await v.page.waitForSelector('main table tbody tr', { timeout: 20000 }); } catch {}
    const rows = await v.page.locator('main table tbody tr').count();
    check('viewer: SQL console runs a query', rows > 3, `${rows} rows`);
    const chartBtn = v.page.locator('.sql-results-bar button:has-text("Chart")');
    if (await chartBtn.count()) await chartBtn.click();
    check('viewer: SQL result drawn as a chart', (await v.page.locator('.sql-chart svg .chart-bar').count()) > 3);
    await v.page.locator('textarea').fill('SELECT lastused FROM entities');
    await v.page.click('button:has-text("Run")');
    await sleep(500);
    const err = await v.page.locator('.sql-error').innerText().catch(() => '');
    check('viewer: SQL error suggests a close column', /Did you mean last_used/.test(err.replace(/\s+/g, ' ')), err.slice(0, 80));
    check('viewer has no Build button with a catalog either', (await v.page.locator('.open-buttons a:has-text("Build")').count()) === 0);
    check('viewer pages without script errors', v.errors.length === 0, v.errors.join('; '));
    await v.close();
  },

  async fields() {
    const a = await session('admin');
    const doc = await uiBuild(a.page, {
      setup: async (p) => {
        if (!(await p.isChecked('label.parts-item:has-text("Discover fields") input'))) {
          await p.check('label.parts-item:has-text("Discover fields") input');
        }
        await p.locator('input[list="delvecat-index-names"]').fill('_internal');
        await p.fill('input.input-seconds', '120');
      },
    });
    check('build with field discovery in _internal finishes', doc?.state === 'done',
      `${doc?.entities} objects; options ${JSON.stringify({ fieldIndexes: doc?.options?.fieldIndexes, t: doc?.options?.searchTimeout, n: doc?.options?.parts?.length })}`);
    const jobs = (await rest('GET', '/services/search/jobs?count=300')).json?.entry || [];
    const searches = jobs.map((e) => ({ spl: e.content.search || '', app: e.acl?.app }));
    const samples = searches.map((j) => j.spl).filter((s) => s.includes('fieldsummary') && !s.includes('inputlookup'));
    check('every field sample searched only _internal', samples.length > 0 && samples.every((s) => s.includes('(index="_internal")') && !s.includes('index=*')), `${samples.length} sample searches`);
    // Lookup files no definition describes: their header is read in the file's own app.
    const headers = searches.filter((j) => /^\| inputlookup "[^"]+" max=20 \| fieldsummary \| fields field/.test(j.spl));
    check('lookup headers read in each file\'s app, field names only', headers.length > 0 && headers.some((j) => j.app && j.app !== 'search'),
      headers.map((j) => `${j.app}: ${j.spl.slice(15, 45)}`).slice(0, 3).join('; '));
    await a.page.goto(app('#/schemas'));
    await sleep(3000);
    check('Schemas page lists sourcetypes with discovered fields', /splunkd/.test(await mainText(a.page)));
    await a.close();
  },

  async partial() {
    const a = await session('admin');
    const before = (await pointer())?.entities;
    let doc = await uiBuild(a.page, {
      setup: async (p) => {
        if (!(await p.isChecked('input[aria-label="Select all parts"]'))) await p.click('input[aria-label="Select all parts"]');
        await p.click('input[aria-label="Select all parts"]'); // none
        await p.click('input[aria-label="Select all of Platform"]');
        const n = await p.locator('.parts-all').innerText();
        check('picker: Select all clears, a group selects its 6 parts', /6 of 65/.test(n), n.trim());
        check('picker warns about a partial catalog', (await mainText(p)).includes('Only the selected parts are read'));
      },
    });
    check('partial build is not published over a bigger catalog', doc?.state === 'failed' && doc.reason === 'smaller' && doc.partial === true,
      `${doc?.entities} vs ${doc?.previousEntities}`);
    check('current catalog unchanged', (await pointer())?.entities === before);
    const t = await mainText(a.page);
    check('page explains it was a partial selection', t.includes('Only some parts were selected'));
    doc = await uiBuild(a.page, { replaceAnyway: true });
    check('"Build and replace anyway" publishes the partial catalog', doc?.state === 'done' && (await pointer())?.entities === doc.entities, `${doc?.entities} objects`);
    // restore a complete catalog
    doc = await uiBuild(a.page, {
      setup: async (p) => {
        await p.click('input[aria-label="Select all parts"]'); // some -> all
        if (!(await p.isChecked('input[aria-label="Select all parts"]'))) await p.click('input[aria-label="Select all parts"]');
      },
    });
    check('Select all builds the complete catalog again', doc?.state === 'done' && doc.options.parts.length === 65, `${doc?.entities} objects`);
    await a.close();
  },

  async health() {
    const ACKS = '/servicesNS/nobody/delvecat/storage/collections/data/delvecat_acks';
    await rest('DELETE', ACKS); // start clean
    const p = await pointer();
    const pub = await session('publisher');
    await pub.page.goto(app('#/health'));
    await pub.page.waitForSelector('.tile-btn', { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    const trend = await pub.page.locator('.health-trend svg').count();
    check('Health page draws the trend over builds', trend === 1, `catalog ${p?.generation}`);
    const t = await mainText(pub.page);
    check('Health page lists every area with findings and the thresholds used', /Thresholds: stale after/.test(t) && /Findings by check/.test(t), t.slice(0, 120));
    await pub.page.locator('.remedy summary').first().click(); // its contents are built when opened
    await sleep(300);
    const link = await pub.page.locator('.remedy a:has-text("Open in Splunk search")').first().getAttribute('href').catch(() => null);
    check('How to fix links to a Splunk search', !!link && /\/app\/search\/search\?q=/.test(link), link || 'no link');
    const before = await pub.page.locator('.finding').count();
    await pub.page.locator('.ack-form summary').first().click();
    await pub.page.locator('.ack-form input[aria-label=Note]').first().fill('e2e: known');
    await pub.page.locator('.ack-form button:has-text("Save")').first().click();
    await sleep(1500);
    const stored = (await rest('GET', ACKS)).json || [];
    check('publisher accepts a finding: saved in the app\'s KV collection', stored.length === 1 && stored[0].by === 'publisher' && stored[0].note === 'e2e: known',
      JSON.stringify(stored[0] || {}).slice(0, 120));
    // Each area shows a page of findings that refills from the next, so count the tile.
    const ackTile = await pub.page.locator('.tile-btn:has-text("acknowledged") .tile-num').innerText().catch(() => '');
    check('accepted finding is hidden from the list', ackTile.trim() === '1' && (await pub.page.locator('.finding').count()) <= before, `acknowledged tile: ${ackTile}`);
    check('publisher pages without script errors', pub.errors.length === 0, pub.errors.join('; '));
    await pub.close();

    const v = await session('viewer');
    await v.page.goto(app('#/health'));
    await v.page.waitForSelector('.tile-btn', { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    await v.page.click('label:has-text("Show acknowledged") input'); await sleep(500);
    await sleep(500);
    const vt = await mainText(v.page);
    check('viewer sees who accepted it', /Accepted by publisher: e2e: known/.test(vt));
    check('viewer cannot acknowledge (no form)', (await v.page.locator('.ack-form').count()) === 0);
    const viaRest = await fetch(`${MGMT}${ACKS}/batch_save?output_mode=json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`viewer:${USERS.viewer}`).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ _key: 'ack-x', entity: 'x', check: 'y', state: 'accepted', status: 'warning', at: 'now' }]),
    });
    check('viewer cannot write acknowledgements through REST', viaRest.status >= 400, `HTTP ${viaRest.status}`);
    check('viewer pages without script errors', v.errors.length === 0, v.errors.join('; '));
    await v.close();

    const pub2 = await session('publisher');
    await pub2.page.goto(app('#/health'));
    await pub2.page.waitForSelector('.tile-btn', { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    await pub2.page.click('label:has-text("Show acknowledged") input'); await sleep(500);
    await pub2.page.locator('.ack-state button:has-text("Undo")').first().click();
    await sleep(1500);
    check('publisher undoes it: removed from the collection', ((await rest('GET', ACKS)).json || []).length === 0);
    await pub2.close();
  },

  async pages() {
    const v = await session('viewer');
    const go = async (hash, wait) => {
      await v.page.goto(app(hash));
      try { await v.page.waitForSelector(wait, { timeout: 30000 }); } catch {}
      await sleep(1200);
    };
    await go('', '.glance');
    check('home: at-a-glance tiles and types grouped by area', (await v.page.locator('.glance .tile').count()) >= 3 && (await v.page.locator('.type-group h3').count()) >= 3);
    await go('#/search?q=_internal&view=table', 'table');
    check('search: table view', (await v.page.locator('main table tbody tr').count()) > 0);
    await go('#/search?q=_internal', '.entity-row');
    check('search: matched words highlighted', (await v.page.locator('.entity-row mark').count()) > 0);
    await v.page.goto(app('#/search?q=_internal&type=index'));
    await sleep(2000);
    const idx = v.page.locator('main a[href*="entity/"]').first();
    if (await idx.count()) { await idx.click(); await sleep(2000); }
    check('object page: "On this page" menu', (await v.page.locator('.section-nav button').count()) >= 4);
    await go('#/search?type=savedSearch&q=index', '.entity-row');
    const ss = v.page.locator('main a[href*="savedSearch"]').first();
    if (await ss.count()) { await ss.click(); await sleep(2000); }
    check('object page: SPL highlighted with linked objects', (await v.page.locator('pre.spl .spl-command, pre.spl .spl-field').count()) > 0,
      `${await v.page.locator('pre.spl a.spl-link').count()} links`);
    await go('#/coverage', 'h1');
    const cov = await mainText(v.page);
    check('coverage: summary by tactic or no detections', /Summary by tactic|no detections/.test(cov) || (await v.page.locator('main table').count()) > 0);
    await go('#/insights?target=described', '.worklist');
    check('insights: a target opens its worklist', (await v.page.locator('.worklist').count()) === 1);
    await go('#/compare?mode=many', 'h1');
    check('compare: several schemas mode', /Several, or against a data model/.test(await mainText(v.page)));
    await go('#/glossary?unused=1', 'h1');
    const noTerms = /No glossary terms/.test(await mainText(v.page));
    check('glossary: filters kept in the URL', noTerms || await v.page.isChecked('label:has-text("Only unused terms") input').catch(() => false), noTerms ? 'no terms in this catalog' : '');
    await go('#/search?q=_internal', '.entity-row');
    await v.page.locator('.entity-row a.entity-name').first().click();
    await sleep(1500);
    check('object opened from a search has Back to results and copy buttons', (await v.page.locator('.back-link a').count()) === 1 && (await v.page.locator('button:has-text("Copy id")').count()) === 1);
    await go('', '.recent-list');
    check('Home lists recently viewed objects', (await v.page.locator('.recent-list li').count()) >= 1);
    await v.page.selectOption('select[aria-label=Theme]', 'dark');
    await sleep(300);
    check('theme can be chosen', (await v.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await v.page.selectOption('select[aria-label=Theme]', 'auto');
    await go('#/help', '.help-section');
    await v.page.fill('input[aria-label="Search help"]', 'snooze');
    await sleep(300);
    check('help: page with searchable topics', (await v.page.locator('.help-section').count()) >= 10 && (await v.page.locator('.help-section:not([hidden])').count()) < 10);
    await go('#/health?status=warning', '.tile-btn');
    check('health: filters read from the URL', (await v.page.locator('select[aria-label="Status"]').inputValue().catch(() => '')) === 'warning');
    check('viewer pages without script errors', v.errors.length === 0, v.errors.join('; '));
    await v.close();
  },

  async testing() {
    // The test Splunk is the only stack here: it tests its own management port.
    // The tokens endpoint refuses output_mode in the body: post it in the URL only.
    const made = await fetch(`${MGMT}/services/authorization/tokens?output_mode=json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`admin:${USERS.admin}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'publisher', audience: 'delvecat-e2e', expires_on: '+1h' }).toString(),
    });
    const madeJson = await made.json().catch(() => ({}));
    const token = madeJson?.entry?.[0]?.content?.token;
    const tokenId = madeJson?.entry?.[0]?.content?.id;
    check('test token created', !!token, `HTTP ${made.status}`);
    const p = await session('publisher');
    await p.page.goto(app('#/testing'));
    await p.page.waitForSelector('form.testing-form', { timeout: 60000 });
    await sleep(1500);
    const run = async (verify) => {
      await p.page.fill('form.testing-form input[type=text]', 'https://127.0.0.1:8089');
      await p.page.fill('form.testing-form input[type=password]', token || '');
      const box = p.page.locator('label:has-text("Verify the TLS certificate") input');
      if ((await box.isChecked()) !== verify) await box.click();
      await p.page.click('button:has-text("Test connection")');
      await p.page.waitForSelector('section[aria-live] h2', { timeout: 60000 }).catch(() => {});
      await sleep(500);
      return mainText(p.page);
    };
    let t = await run(false);
    check('testing: reaches the stack, token accepted, app and catalog found', /Reachable/.test(t) && /Token accepted\s*✓ OK/.test(t) && /App installed\s*✓ OK/.test(t) && /Catalog published\s*✓ OK/.test(t), t.slice(t.indexOf('127.0.0.1:8089'), t.indexOf('127.0.0.1:8089') + 300));
    check('testing: the token field is cleared after the test', (await p.page.inputValue('form.testing-form input[type=password]')) === '');
    t = await run(true);
    check('testing: an untrusted certificate fails the TLS step with advice', /Not reachable/.test(t) && /not trusted/.test(t));
    check('publisher pages without script errors', p.errors.length === 0, p.errors.join('; '));
    await p.close();
    const v = await session('viewer');
    await v.page.goto(app('#/testing'));
    await v.page.waitForSelector('form.testing-form', { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    check('viewer cannot run connection tests', await v.page.isDisabled('button:has-text("Test connection")') && /Only catalog publishers/.test(await mainText(v.page)));
    await v.close();
    const denied = await fetch(`${MGMT}/services/delvecat/connectivity?output_mode=json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`viewer:${USERS.viewer}`).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://127.0.0.1:8089' }),
    });
    check('viewer is refused by the endpoint too', denied.status === 403, `HTTP ${denied.status}`);
    if (tokenId) await rest('DELETE', `/services/authorization/tokens/publisher?id=${encodeURIComponent(tokenId)}`);
  },

  async transfer() {
    // A second "stack": the recorded test fixtures, built as instance es-e2e, imported as a file.
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'delvecat-e2e-'));
    const file = path.join(dir, 'es.json');
    execSync(`uv run delvecat-ingest build --fixtures tests/fixtures/splunk-9.4-dev --instance es-e2e --instance-name "ES e2e" --out ${file}`,
      { cwd: path.join(__dirname, '../../ingestion'), stdio: 'ignore' });
    const before = await pointer();
    const p = await session('publisher');
    await p.page.goto(app('#/build'));
    await p.page.waitForSelector('.transfer', { timeout: 60000 });
    await sleep(1500);
    const [download] = await Promise.all([
      p.page.waitForEvent('download', { timeout: 60000 }),
      p.page.click('button:has-text("Download this catalog")'),
    ]);
    const saved = path.join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    const exported = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(saved)).toString());
    check('export downloads the published catalog', exported.entities.length === before.entities && /\.json\.gz$/.test(saved), `${exported.entities.length} objects, ${path.basename(saved)}`);
    await p.page.click('.transfer button[role=tab]:has-text("From a file")');
    await p.page.setInputFiles('.transfer input[type=file]', file);
    await p.page.click('.transfer button:has-text("Import")');
    await p.page.waitForSelector('.transfer [role=status], .transfer [role=alert]', { timeout: 300000 });
    let t = await p.page.locator('.transfer').innerText();
    let ptr = await pointer();
    check('import a file: combined with this stack', /Imported from file/.test(t) && (ptr.instances || []).includes('es-e2e') && (ptr.instances || []).length >= 2, `${ptr.instances}`);
    check('pointer names the importer', ptr.publishedBy === 'publisher' && /^file /.test(ptr.importedFrom || ''));
    // A build keeps the imported instance, replacing only this stack's part.
    const prev = (await buildDoc())?.sid;
    await oneshot('| delvecatbuild searchtimeout=120', 'admin'); // admin, as the other sections: a narrower view is refused as "much smaller"
    const doc = await waitBuild(prev);
    ptr = await pointer();
    const own = doc?.instance;
    check('a build keeps imported instances and replaces only its own part', doc?.state === 'done' && (ptr.instances || []).includes('es-e2e')
      && (ptr.instances || []).every((i) => i === 'es-e2e' || i === own), `${ptr.instances}; kept ${doc?.keptInstances}`);
    await p.page.reload();
    await p.page.waitForSelector('.transfer', { timeout: 60000 });
    await sleep(1500);
    // Directly from a stack: this test Splunk itself, with a token (its own instance is replaced by itself).
    const madeResp = await fetch(`${MGMT}/services/authorization/tokens?output_mode=json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`admin:${USERS.admin}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'publisher', audience: 'delvecat-e2e', expires_on: '+1h' }).toString(),
    });
    const made = (await madeResp.json().catch(() => ({})))?.entry?.[0]?.content || {};
    await p.page.click('.transfer button[role=tab]:has-text("From another stack")');
    await p.page.fill('.transfer input[type=text]', 'https://127.0.0.1:8089');
    await p.page.fill('.transfer input[type=password]', made.token || '');
    await p.page.click('.transfer label:has-text("Verify the TLS certificate") input');
    await p.page.click('.transfer button:has-text("Import")');
    await sleep(1000);
    await p.page.waitForSelector('.transfer [role=status], .transfer [role=alert]', { timeout: 300000 });
    t = await p.page.locator('.transfer').innerText();
    ptr = await pointer();
    check('import from another stack: read it and combined', /Imported from stack 127\.0\.0\.1:8089/.test(t) && (ptr.instances || []).includes('es-e2e'), t.slice(-200).replace(/\s+/g, ' '));
    check('publisher pages without script errors', p.errors.length === 0, p.errors.join('; '));
    await p.close();
    // The Build page lists imported stacks; Remove publishes the catalog without one.
    const r = await session('publisher');
    await r.page.goto(app('#/build'));
    await r.page.waitForSelector('.imported-list', { timeout: 60000 }).catch(() => {});
    await sleep(1000);
    const listed = await r.page.locator('.imported-list').innerText().catch(() => '');
    check('Build page lists imported stacks with source and age', /ES e2e/.test(listed) && /from /.test(listed), listed.slice(0, 120));
    await r.page.goto(app('#/health?instance=es-e2e'));
    await r.page.waitForSelector('.tile-btn', { timeout: 60000 }).catch(() => {});
    await sleep(800);
    check('Health filters by stack', (await r.page.locator('select[aria-label="Stack"]').inputValue().catch(() => '')) === 'es-e2e');
    await r.page.goto(app('#/build'));
    await r.page.waitForSelector('.imported-list', { timeout: 60000 }).catch(() => {});
    await sleep(800);
    r.page.once('dialog', (d) => d.accept());
    await r.page.locator('.imported-list li', { hasText: 'ES e2e' }).locator('button:has-text("Remove")').click();
    await sleep(4000);
    check('Remove takes an imported stack out of the catalog', !((await pointer()).instances || []).includes('es-e2e'));
    check('publisher pages without script errors', r.errors.length === 0, r.errors.join('; '));
    await r.close();
    // Back to this stack only, for the other sections.
    const prev2 = (await buildDoc())?.sid;
    await oneshot('| delvecatbuild keepimported=false replacesmaller=true searchtimeout=120', 'admin');
    await waitBuild(prev2);
    check('keepimported=false builds this stack alone', !((await pointer()).instances || []).includes('es-e2e'));
    if (made.id) await rest('DELETE', `/services/authorization/tokens/publisher?id=${encodeURIComponent(made.id)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  async timelimit() {
    const a = await session('admin');
    const doc = await uiBuild(a.page, {
      setup: async (p) => {
        if (!(await p.isChecked('input[aria-label="Select all parts"]'))) await p.click('input[aria-label="Select all parts"]');
        if (!(await p.isChecked('input[aria-label="Select all parts"]'))) await p.click('input[aria-label="Select all parts"]');
        await p.locator('input[list="delvecat-index-names"]').fill('');
        await p.fill('input.input-seconds', '1');
      },
    });
    const timed = (doc?.problems || []).filter((p) => /time limit/.test(p.message));
    check('build with a 1-second search limit still finishes', doc?.state === 'done' || doc?.reason === 'smaller', `${doc?.state} ${doc?.reason || ''}`);
    console.log(`      parts that hit the 1 s limit: ${timed.map((p) => p.connector).join(', ') || 'none'}`);
    const shown = await mainText(a.page);
    if (timed.length) check('timed-out parts are listed on the page', shown.includes('time limit'));
    await a.close();
  },

  async cancel() {
    const a = await session('admin');
    await a.page.goto(app('#/build'));
    await a.page.waitForSelector('fieldset.parts');
    await sleep(1500);
    await a.page.fill('input.input-seconds', '300');
    await a.page.click('button:has-text("Build now")');
    await a.page.waitForSelector('button:has-text("Cancel")', { timeout: 20000 });
    await sleep(1500);
    await a.page.click('button:has-text("Cancel")');
    try { await a.page.waitForSelector('h2:has-text("Last build failed")', { timeout: 30000 }); } catch {}
    check('Cancel stops a running build', (await mainText(a.page)).includes('ended before it finished'));
    const prev = (await buildDoc())?.sid;
    await a.page.click('button:has-text("Build now")');
    const doc = await waitBuild(prev);
    await sleep(2500);
    check('a new build right after a cancel finishes', doc?.state === 'done' && (await mainText(a.page)).includes('Last build'), `${doc?.entities} objects`);
    await a.close();
  },

  async concurrency() {
    const prev = (await buildDoc())?.sid;
    const first = rest('POST', '/servicesNS/admin/delvecat/search/jobs', 'admin', { search: '| delvecatbuild', exec_mode: 'oneshot' });
    await sleep(2500);
    const second = await oneshot('| delvecatbuild');
    const msg = JSON.stringify(second.messages || second).slice(0, 200);
    check('a second build is refused while one runs', /still running/.test(msg), msg);
    await first;
    const doc = await waitBuild(prev);
    check('the first build still finishes', doc?.state === 'done');
  },

  async publisher() {
    const p = await session('publisher');
    await p.page.goto(app());
    await p.page.waitForSelector('h1');
    await sleep(2000);
    check('publisher sees the Build button', (await p.page.locator('.open-buttons a:has-text("Build")').count()) === 1);
    const doc = await uiBuild(p.page);
    check('publisher (user role) build is not published: sees less than admin', doc?.state === 'failed' && doc.reason === 'smaller' && !doc.partial,
      `${doc?.entities} vs ${doc?.previousEntities}`);
    check('page explains the builder sees less', (await mainText(p.page)).includes('probably sees less'));
    await p.close();
  },

  async layout() {
    // Every page fits the window from phone to wide screen: no sideways scrolling of the
    // page (graphs and tables may scroll inside their own boxes).
    const a = await session('admin');
    const p = a.page;
    await p.goto(app('#/search?q=_internal&type=index'));
    await sleep(3000);
    const idx = await p.locator('main a[href*="entity/"]').first().getAttribute('href');
    const pages = ['', '#/search?q=index', idx, `${idx}?tab=lineage`, '#/schemas', '#/coverage', '#/health',
      '#/governance', '#/insights', '#/sql', '#/build'];
    for (const [w, h] of [[375, 812], [1280, 800], [2560, 1440]]) {
      await p.setViewportSize({ width: w, height: h });
      const wide = [];
      for (const hash of pages) {
        await p.goto(app(hash));
        await p.waitForSelector('main h1, main h2', { timeout: 30000 }).catch(() => {});
        await sleep(1500);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) wide.push(`${hash || 'home'} +${over}px`);
      }
      check(`${w}px wide: no page scrolls sideways`, wide.length === 0, wide.join(', '));
      await p.goto(app('#/schemas'));
      await sleep(2500);
      const net = await p.locator('.network-svg').first().boundingBox();
      if (net) check(`${w}px wide: schema network between 640 and 1100px`, net.width >= 639 && net.width <= 1101, `${Math.round(net.width)}px`);
    }
    await a.close();
  },

  async dryrun() {
    const before = (await pointer())?.generation;
    const r = await oneshot('| delvecatbuild dryrun=true');
    const row = (r.results || [])[0] || {};
    check('dry run builds without publishing', row.status === 'done' && row.dry_run === '1' && (await pointer())?.generation === before, `${row.entities} objects`);
  },
};

(async () => {
  browser = await chromium.launch();
  for (const [name, fn] of Object.entries(sections)) {
    if (ONLY && !ONLY.has(name)) continue;
    console.log(`\n== ${name}`);
    try { await fn(); } catch (e) { check(`${name}: ran without crashing`, false, e.message.split('\n')[0]); }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
