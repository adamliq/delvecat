// End-to-end test of the DelveCat Splunk app against a disposable test Splunk.
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
    check('Build page opens from the empty state, default 40 of 41 parts', /40 of 41/.test(all), all.trim());
    await a.close();
  },

  async build() {
    const a = await session('admin');
    const t0 = Date.now();
    const doc = await uiBuild(a.page);
    check('default build from the page finishes and publishes', doc?.state === 'done' && !doc.dryRun,
      `${doc?.entities} objects, ${doc?.edges} relationships in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    check('default build ran 40 parts (no field discovery)', doc?.options?.parts?.length === 40 && !doc.options.parts.includes('fields'));
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
    const samples = jobs.map((e) => e.content.search || '').filter((s) => s.includes('fieldsummary'));
    check('every field sample searched only _internal', samples.length > 0 && samples.every((s) => s.includes('(index="_internal")') && !s.includes('index=*')), `${samples.length} sample searches`);
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
        check('picker: Select all clears, a group selects its 4 parts', /4 of 41/.test(n), n.trim());
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
    check('Select all builds the complete catalog again', doc?.state === 'done' && doc.options.parts.length === 41, `${doc?.entities} objects`);
    await a.close();
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
