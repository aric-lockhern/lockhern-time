// Browser test (Playwright). Serves the real pages and mounts the REAL fast function
// (netlify/lib/fastapi.mjs) on /api, fed by the REAL publisher (apps-script/Publish.gs). It proves
// the employee page reads from /api when a snapshot is published, and falls back to /api/proxy
// (Apps Script) when nothing is published. Run with: npm run test:ui  (not part of `npm test`).
//
// Not gated by the Netlify build. Chromium is expected pre-installed (PLAYWRIGHT_BROWSERS_PATH).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadApp, spreadsheet } from '../tests/harness.mjs';
import { tabs, SECRET, ADMIN_PASSWORD } from '../tests/fixtures.mjs';
import { handle } from '../netlify/lib/fastapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GLOBAL = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(path.join(GLOBAL, 'anchor.cjs'))('playwright');

// ---- a store published through the real publisher, and an empty one (nothing published) ----
function memStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); } };
}
const env = { INGEST_SECRET: SECRET, ADMIN_PASSWORD };
async function publishedStore() {
  const store = memStore(), sent = [];
  const state = { ss: spreadsheet(tabs()), props: { INGEST_SECRET: SECRET, API_SECRET: SECRET } };
  state.fetch = (url, opt) => {
    const b = JSON.parse(opt.payload);
    b.gz = gzipSync(Buffer.from(b.gz, 'base64')).toString('base64');
    sent.push(handle(new Request(url, { method: 'POST', headers: { authorization: opt.headers.Authorization }, body: JSON.stringify(b) }), store, env));
    return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
  };
  const g = loadApp(state);
  g.publishSoon_();
  await Promise.all(sent);
  return store;
}

// Apps Script authority (the slow path), enough for the employee page to render on fallback.
function proxyAnswer(action, params) {
  if (action === 'empList') return { ok: true, people: [{ name: 'Aric', slug: 'aric' }] };
  if (action === 'empLoad') {
    return { ok: true, user: { name: 'Aric (slow)', slug: 'aric', weeklyHours: 40, type: 'full' },
      week: params.get('week') || '2026-10-09', weeks: ['2026-10-09'],
      clients: [{ id: 'internal', name: 'Internal', assigned: true }, { id: 'pto', name: 'PTO / time off', assigned: true, pto: true }],
      allClients: [], hours: {}, submitted: false };
  }
  return { ok: false, error: 'unknown' };
}

function makeServer(store) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + (u.search || ''));
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html'))); return;
    }
    if (u.pathname === '/admin' || u.pathname === '/admin.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, 'public', 'admin.html'))); return;
    }
    if (u.pathname === '/api' || u.pathname === '/api/ingest') {           // the REAL fast function
      const r = await handle(new Request('http://x' + req.url, { method: req.method, headers: { 'x-admin-pass': req.headers['x-admin-pass'] || '' } }), store, env);
      const body = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(body); return;
    }
    if (u.pathname === '/api/proxy') {                                     // the slow Apps Script authority
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(proxyAnswer(u.searchParams.get('action'), u.searchParams))); return;
    }
    res.writeHead(404); res.end('no');
  });
  return { server, hits };
}
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    // 1) Snapshot published → the page reads from /api and never touches /api/proxy for the load.
    {
      const { server, hits } = makeServer(await publishedStore());
      const port = await listen(server);
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/?user=aric`);
      await page.waitForFunction(() => /Hi, Aric/.test(document.getElementById('hello').textContent), { timeout: 8000 });
      const text = await page.locator('#hello').textContent();
      assert.equal(text, 'Hi, Aric', 'served the fast (published) name, not the slow one');
      assert.ok(hits.some((h) => h.startsWith('/api?') && h.includes('empLoad')), 'the page called the fast /api');
      assert.ok(!hits.some((h) => h.startsWith('/api/proxy') && h.includes('empLoad')), 'and did NOT fall back to /api/proxy');
      await page.close(); server.close();
      console.log('ok 1 - fast path serves the employee page from /api');
    }
    // 2) Nothing published → /api answers fallback, the page asks Apps Script (/api/proxy) and renders.
    {
      const { server, hits } = makeServer(memStore());   // empty store → every read falls back
      const port = await listen(server);
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/?user=aric`);
      await page.waitForFunction(() => /Hi, Aric/.test(document.getElementById('hello').textContent), { timeout: 8000 });
      const text = await page.locator('#hello').textContent();
      assert.equal(text, 'Hi, Aric (slow)', 'rendered from the Apps Script fallback');
      assert.ok(hits.some((h) => h.startsWith('/api?') && h.includes('empLoad')), 'tried the fast path first');
      assert.ok(hits.some((h) => h.startsWith('/api/proxy') && h.includes('empLoad')), 'then fell back to Apps Script');
      await page.close(); server.close();
      console.log('ok 2 - fallback to Apps Script when nothing is published');
    }
  } finally {
    await browser.close();
  }
  console.log('# browser tests passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
