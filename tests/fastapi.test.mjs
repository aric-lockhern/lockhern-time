// The fast read path (netlify/lib/fastapi.mjs) must answer exactly as the Apps Script read
// functions do, and never widen who can see what. These tests publish the fixture through the
// REAL publisher (Publish.gs) into the REAL function (an in-memory Blobs store), then compare
// every answer with the Apps Script builders in Code.gs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadApp, spreadsheet } from './harness.mjs';
import { tabs, SECRET, ADMIN_PASSWORD, BASE, W_THIS, W_PREV } from './fixtures.mjs';
import { handle } from '../netlify/lib/fastapi.mjs';

const plain = (x) => JSON.parse(JSON.stringify(x));

function memStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); } };
}

// Apps Script -> /api/ingest. Utilities.gzip in the harness is a no-op, so this bridge gzips for
// real on the way in, exactly as the deployed function receives it.
function world() {
  const store = memStore();
  const env = { INGEST_SECRET: SECRET, ADMIN_PASSWORD };
  const sent = [];
  const state = { ss: spreadsheet(tabs()), props: { INGEST_SECRET: SECRET, API_SECRET: SECRET } };
  state.fetch = (url, opt) => {
    const b = JSON.parse(opt.payload);
    b.gz = gzipSync(Buffer.from(b.gz, 'base64')).toString('base64');
    const req = new Request(url, {
      method: 'POST',
      headers: { authorization: opt.headers.Authorization, 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    const done = handle(req, store, env).then(async (r) => ({ code: r.status, body: await r.json() }));
    sent.push(done);
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
  };
  const g = loadApp(state);
  const flush = () => Promise.all(sent.splice(0));
  const fast = async (q, headers) => {
    const r = await handle(new Request(BASE + '/api?' + new URLSearchParams(q), { headers: headers || {} }), store, env);
    let body; try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body };
  };
  return { g, state, store, env, flush, fast };
}
async function published() { const w = world(); w.g.publishSoon_(); await w.flush(); return w; }

test('the publisher sends one snapshot; nothing without the secret', async () => {
  const w = await published();
  assert.ok(w.store.m.has('snapshot'), 'snapshot stored');
  const snap = JSON.parse(w.store.m.get('snapshot'));
  assert.ok(snap.empList && snap.emp.aric && snap.admin.load, 'has roster, a person, admin data');
  assert.deepEqual(snap.employees.sort(), ['aric', 'bea', 'cy'], 'active slugs only');
  // The roster and timesheets carry no emails (only admin data may).
  assert.ok(!JSON.stringify(snap.empList).includes('@'), 'empList has no emails');
  assert.ok(snap.emp.aric[W_THIS].user && snap.emp.aric[W_THIS].user.email === undefined, 'empLoad user has no email');

  // With no INGEST_SECRET in Script Properties, the publisher is a no-op (pubOn_ is false).
  const off = world();
  off.state.props.INGEST_SECRET = '';
  let calls = 0; off.state.fetch = () => { calls++; return { getResponseCode: () => 200, getContentText: () => '{}' }; };
  off.g.publishSoon_();
  assert.equal(calls, 0, 'nothing sent without the secret');
});

test('same answers as Apps Script: empList, empLoad (every person × week), admin reads', async () => {
  const w = await published();
  const weeks = w.g.recentFridays_(12);
  const months = w.g.adminMonths();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // empList (open)
  assert.deepStrictEqual((await w.fast({ action: 'empList' })).body, plain(w.g.empList()));

  // empLoad for every active person and every published week, plus the blank (default) week.
  for (const slug of ['aric', 'bea', 'cy']) {
    for (const wk of weeks) {
      const f = await w.fast({ action: 'empLoad', slug, week: wk });
      assert.equal(f.body.ok, true, slug + ' ' + wk + ': ' + (f.body.error || ''));
      assert.deepStrictEqual(f.body, plain(w.g.empLoad(slug, wk)), slug + ' ' + wk);
    }
    const blank = await w.fast({ action: 'empLoad', slug });
    assert.deepStrictEqual(blank.body, plain(w.g.empLoad(slug, '')), slug + ' default week');
  }

  // Admin reads (gated), each identical to its Apps Script builder.
  assert.deepStrictEqual((await w.fast({ action: 'adminLoad' }, H)).body, plain(w.g.adminLoad()));
  assert.deepStrictEqual((await w.fast({ action: 'adminMonths' }, H)).body, plain({ ok: true, months: w.g.adminMonths() }));
  for (const wk of weeks) {
    assert.deepStrictEqual((await w.fast({ action: 'adminMatrix', period: wk, scope: 'week' }, H)).body, plain(w.g.adminMatrix(wk, 'week')), 'matrix week ' + wk);
    assert.deepStrictEqual((await w.fast({ action: 'adminStatus', week: wk }, H)).body, plain(w.g.adminSubmissionStatus(wk)), 'status ' + wk);
  }
  for (const m of months) {
    assert.deepStrictEqual((await w.fast({ action: 'adminMatrix', period: m, scope: 'month' }, H)).body, plain(w.g.adminMatrix(m, 'month')), 'matrix month ' + m);
  }

  // Non-trivial content (so the equality above isn't comparing two empties).
  const load = (await w.fast({ action: 'adminLoad' }, H)).body;
  assert.equal(load.defaultPeriod, W_PREV);
  assert.ok(load.matrix0.matrix.c1 && load.matrix0.matrix.c1.u1 === 8, 'Aric logged 8h on Acme in the previous week (5+3)');
  const status = (await w.fast({ action: 'adminStatus', week: W_PREV }, H)).body;
  const byName = {}; status.rows.forEach((r) => { byName[r.name] = r.submitted; });
  assert.deepEqual(byName, { Aric: true, Bea: true, Cy: false }, 'submission state for the previous week');
  const aric = (await w.fast({ action: 'empLoad', slug: 'aric', week: W_THIS })).body;
  assert.equal(aric.hours.pto['2026-10-06'], 8, 'Aric has 8h PTO');
  assert.equal(aric.hours.c1['2026-10-05'], 4, 'and 4h on Acme');
});

test('SECURITY: who can see what is unchanged on the fast path', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // Employee reads need no password (the private ?user= link is the gate).
  assert.equal((await w.fast({ action: 'empList' })).body.ok, true);
  assert.equal((await w.fast({ action: 'empLoad', slug: 'aric', week: W_THIS })).body.ok, true);

  // Admin reads require the ADMIN_PASSWORD, checked exactly as proxy.js checks it.
  assert.equal((await w.fast({ action: 'adminLoad' }, H)).body.ok, true, 'correct password → served');
  const wrong = await w.fast({ action: 'adminLoad' }, { 'x-admin-pass': 'nope' });
  assert.equal(wrong.status, 401); assert.equal(wrong.body.error, 'admin_auth'); assert.ok(!wrong.body.fallback, 'a wrong password is a refusal, not a fallback');
  const none = await w.fast({ action: 'adminLoad' });   // no header at all
  assert.equal(none.status, 401);

  // When ADMIN_PASSWORD isn't configured on Netlify, the function can't verify → it falls back.
  const noEnv = await handle(new Request(BASE + '/api?action=adminLoad', { headers: H }), w.store, { INGEST_SECRET: SECRET });
  assert.equal((await noEnv.json()).fallback, true);

  // A wrong password is refused even for a period that isn't published (auth is checked first).
  const wrongUnpub = await w.fast({ action: 'adminStatus', week: '1999-01-01' }, { 'x-admin-pass': 'nope' });
  assert.equal(wrongUnpub.status, 401);

  // Unknown person, unpublished week, or an admin period with no sub-blob → fall back to Apps Script.
  assert.equal((await w.fast({ action: 'empLoad', slug: 'ghost', week: W_THIS })).body.fallback, true);
  assert.equal((await w.fast({ action: 'empLoad', slug: 'aric', week: '1999-01-01' })).body.fallback, true);
  const unpub = await w.fast({ action: 'adminStatus', week: '1999-01-01' }, H);
  assert.equal(unpub.body.fallback, true); assert.equal(unpub.body.result, undefined);
});

test('ingest refuses a wrong, missing, or short secret, and fails closed with none configured', async () => {
  const w = world();
  const goodSnap = { at: 1, empList: { ok: true, people: [] }, emp: {}, admin: {}, employees: [] };
  const post = (auth, env) => handle(new Request(BASE + '/api/ingest', {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ gz: gzipSync(JSON.stringify(goodSnap)).toString('base64') }),
  }), w.store, env || w.env);
  assert.equal((await post('Bearer wrong')).status, 403);
  assert.equal((await post('')).status, 403);
  assert.equal((await post('Bearer ' + SECRET, {})).status, 403, 'no INGEST_SECRET on Netlify: refuse everything');
  assert.equal((await post('Bearer short', { INGEST_SECRET: 'short' })).status, 403, 'a secret under 24 chars is refused');
  assert.equal((await post('Bearer ' + SECRET)).status, 200);
  // Only GET reads and POST /api/ingest are served.
  assert.equal((await handle(new Request(BASE + '/api?action=ping', { method: 'DELETE' }), w.store, w.env)).status, 405);
});

test('before anything is published, every read falls back; ping reports state without leaking', async () => {
  const w = world();
  assert.equal((await w.fast({ action: 'empLoad', slug: 'aric', week: W_THIS })).body.fallback, true);
  assert.equal((await w.fast({ action: 'adminLoad' }, { 'x-admin-pass': ADMIN_PASSWORD })).body.fallback, true);
  const ping0 = (await w.fast({ action: 'ping' })).body;
  assert.equal(ping0.published, false);

  w.g.publishSoon_(); await w.flush();
  const ping1 = (await w.fast({ action: 'ping' })).body;
  assert.ok(ping1.published && ping1.employees === 3 && ping1.at, 'ping says the Sheet has published');
  assert.ok(!JSON.stringify(ping1).includes('@') && !JSON.stringify(ping1).includes('aric'), 'ping names no people or emails');
});

test('a write republishes at once, so the fast path is never staler than Apps Script', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // An employee saving new hours goes through the real router, which fires publishSoon_.
  w.g.doPost({ postData: { contents: JSON.stringify({
    key: SECRET, action: 'empSave', slug: 'aric', week: W_THIS, days: { c1: { '2026-10-05': 9 } }, assign: [],
  }) } });
  await w.flush();
  const after = (await w.fast({ action: 'empLoad', slug: 'aric', week: W_THIS })).body;
  assert.equal(after.hours.c1['2026-10-05'], 9, 'the fast path shows the just-saved hours');
  assert.deepStrictEqual(after, plain(w.g.empLoad('aric', W_THIS)), 'and still matches Apps Script');

  // Deactivating a client republishes too.
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'toggleClient', id: 'c2', active: false }) } });
  await w.flush();
  const load = (await w.fast({ action: 'adminLoad' }, H)).body;
  const c2 = load.clients.find((c) => c.id === 'c2');
  assert.equal(c2.active, false, 'the fast path reflects the deactivated client');
  assert.deepStrictEqual(load, plain(w.g.adminLoad()));

  // A hand edit to a data tab reaches the fast path through the installable onEdit.
  w.g.onEditPublish({ range: { getSheet: () => ({ getName: () => 'Clients' }) } });
  await w.flush();
  assert.equal((await w.fast({ action: 'ping' })).body.published, true);
});

test('revenue: fast path matches Apps Script, and channel dollars roll up to the right people', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // Same answer as the Apps Script builder, and gated like the other admin reads.
  const fast = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(fast, plain(w.g.adminRevenue()));
  assert.equal((await w.fast({ action: 'adminRevenue' }, { 'x-admin-pass': 'nope' })).status, 401);

  // c1 = 10k (2k AI SEO → fallback u1+u2, 5k Paid Search → u1, 3k Meta → u2);
  // c2 = 6k Paid Search → fallback u2+u3.  Expected managed revenue:
  //   Aric  = 1000 (seo) + 5000 (ps)            = 6000
  //   Bea   = 1000 (seo) + 3000 (meta) + 3000   = 7000
  //   Cy    = 3000 (c2 ps)                       = 3000
  const byName = {}; fast.byPerson.forEach((p) => { byName[p.name] = p.total; });
  assert.deepEqual(byName, { Bea: 7000, Aric: 6000, Cy: 3000 });
  assert.deepEqual(fast.byPerson.map((p) => p.name), ['Bea', 'Aric', 'Cy'], 'sorted by managed revenue');
  assert.equal(fast.unassigned, 0, 'every funded channel has an owner (explicit or fallback)');
  assert.deepEqual(fast.totals, { monthly: 16000, allocated: 16000, attributed: 16000 });

  // Assigning c2's Paid Search explicitly to Cy moves that 6k off the fallback (Bea+Cy).
  w.g.doPost({ postData: { contents: JSON.stringify({
    key: SECRET, action: 'saveChannelOwners', clientId: 'c2', channelId: 'ch_ps', userIds: ['u3'],
  }) } });
  await w.flush();
  const after = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(after, plain(w.g.adminRevenue()), 'still matches Apps Script after the write');
  const m2 = {}; after.byPerson.forEach((p) => { m2[p.name] = p.total; });
  assert.equal(m2.Cy, 6000, 'Cy now owns all of c2 Paid Search');
  assert.equal(m2.Bea, 4000, 'Bea keeps only her c1 channels');
});

test('revenue: editing the split and channels republishes and re-attributes', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // Re-split c1: move everything to Meta (Bea). Aric loses his Paid Search 5k; keeps nothing on c1
  // except his half of a now-zero AI SEO. Bea gets all 10k of c1.
  w.g.doPost({ postData: { contents: JSON.stringify({
    key: SECRET, action: 'saveClientRevenue', clientId: 'c1', monthly: 10000, notes: '',
    splits: { ch_meta: 10000 },
  }) } });
  await w.flush();
  const r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(r, plain(w.g.adminRevenue()));
  const m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  assert.equal(m.Bea, 13000, 'Bea: 10k of c1 Meta + her 3k share of c2 Paid Search');
  assert.ok(!m.Aric, 'Aric has no c1 channels any more');

  // Removing a channel keeps it out of the active list but doesn't crash the rollup.
  const chans = w.g.adminRevenue().channels.filter((c) => c.name !== 'Meta').map((c) => ({ id: c.id, name: c.name, active: true }));
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'saveChannels', channels: chans }) } });
  await w.flush();
  const r2 = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.ok(!r2.channels.some((c) => c.name === 'Meta'), 'Meta no longer an active channel');
});

test('revenue: specialties pre-pick the channel owner, and salary shows per person', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // Baseline: c1 AI SEO (no explicit owner) splits 2k between its assignees u1 + u2.
  let r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  let m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  assert.equal(m.Aric, 6000); assert.equal(m.Bea, 7000);

  // Make Aric the AI SEO specialist → c1 AI SEO routes entirely to him (he's one of the assignees).
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'saveTeamSkills', userId: 'u1', channelIds: ['ch_seo'] }) } });
  await w.flush();
  r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(r, plain(w.g.adminRevenue()), 'still matches Apps Script');
  m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  assert.equal(m.Aric, 7000, 'Aric gets all of c1 AI SEO as its specialist');
  assert.equal(m.Bea, 6000, 'Bea loses her half of AI SEO');
  assert.deepEqual(r.skills.u1, ['ch_seo']);

  // Salary is stored and surfaced per person (the ×-salary multiple is computed in the page).
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'saveSalary', userId: 'u1', salary: 120000 }) } });
  await w.flush();
  r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.equal(r.salaries.u1, 120000);
  assert.equal(r.byPerson.find((p) => p.name === 'Aric').salary, 120000);
});

test('revenue: bulk import sets retainers, and an unsplit remainder goes to the client’s people', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };

  // Bump c1 to 12k via import; its 10k of channel splits stay, and the extra 2k is "unspecified" →
  // split evenly across c1's assignees (u1 + u2). Import must not wipe splits.
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'importRevenue', items: [{ clientId: 'c1', monthly: 12000 }] }) } });
  await w.flush();
  const r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(r, plain(w.g.adminRevenue()));
  const m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  assert.equal(m.Aric, 7000, 'Aric: 6000 + half of the 2k remainder');
  assert.equal(m.Bea, 8000, 'Bea: 7000 + half of the 2k remainder');
  assert.equal(m.Cy, 3000);
  const c1 = r.byClient.find((c) => c.clientId === 'c1');
  assert.equal(c1.monthly, 12000);
  assert.equal(c1.unallocated, 2000);
  assert.equal(r.revenue.c1.splits.ch_ps, 5000, 'import left the channel splits intact');
});

test('revenue: a channel defaults to its specialists, even ones not assigned to the client', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };
  // Make Aric (u1) the Paid Search specialist. c2's Paid Search has no explicit owner and u1 isn't
  // even assigned to c2 — but as the PS specialist he now owns it by default.
  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'saveTeamSkills', userId: 'u1', channelIds: ['ch_ps'] }) } });
  await w.flush();
  const r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.deepStrictEqual(r, plain(w.g.adminRevenue()));
  const m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  // c1 ps is explicitly u1 (5000); c1 seo no specialist → c1 assignees u1,u2 (1000 each); c1 meta
  // explicit u2 (3000); c2 ps → specialist u1 (6000). Aric 5000+1000+6000, Bea 1000+3000, Cy 0.
  assert.equal(m.Aric, 12000);
  assert.equal(m.Bea, 4000);
  assert.equal(m.Cy || 0, 0, 'Cy loses c2 Paid Search to the specialist');
});

test('revenue: unchecking a client (inactive) removes it from every revenue view', async () => {
  const w = await published();
  const H = { 'x-admin-pass': ADMIN_PASSWORD };
  let r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.ok(r.clients.some((c) => c.id === 'c2') && r.byClient.some((c) => c.clientId === 'c2'));

  w.g.doPost({ postData: { contents: JSON.stringify({ key: SECRET, action: 'toggleClient', id: 'c2', active: false }) } });
  await w.flush();
  r = (await w.fast({ action: 'adminRevenue' }, H)).body;
  assert.ok(!r.clients.some((c) => c.id === 'c2'), 'gone from the setup list');
  assert.ok(!r.byClient.some((c) => c.clientId === 'c2'), 'gone from byClient');
  const m = {}; r.byPerson.forEach((p) => { m[p.name] = p.total; });
  assert.equal(m.Cy || 0, 0, 'Cy only had c2 revenue → now 0');
});
