// The timesheet's fast read path. Apps Script (apps-script/Publish.gs) publishes ONE snapshot —
// the verbatim output of every read function the pages call (empList, empLoad per person+week,
// adminLoad, adminMatrix, adminMonths, adminStatus) — to Netlify Blobs through /api/ingest. This
// serves the pages' reads from that snapshot, on the site's own address, without Google's Apps
// Script web-app front end (measured slow: 3-50 s, random 404s; the script itself runs in ms).
//
// It changes WHERE reads are served, never WHAT they return or WHO may see it:
//   - Employee reads (empList, empLoad) are open, gated only by the private ?user=<slug> link —
//     exactly as netlify/functions/proxy.js leaves them open.
//   - Admin reads (adminLoad, adminMatrix, adminMonths, adminStatus) require the ADMIN_PASSWORD,
//     checked here against the same Netlify env var and x-admin-pass header the proxy uses.
//   - Every value returned is the byte-for-byte output of the Apps Script read function, so the
//     two can never drift. The function does zero data transformation.
//
// Anything it can't positively serve from the published snapshot (nothing published yet, a slug
// or week not in the snapshot, an admin read with no sub-blob) answers {ok:false, fallback:true}
// and the page asks Apps Script, which stays the authority. A real refusal (admin password wrong)
// is a normal error (HTTP 401 admin_auth), NOT a fallback. tests/fastapi.test.mjs pins all of it.
import { gunzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';

// Read actions the admin console makes — gated by ADMIN_PASSWORD, same list as proxy.js reads.
const ADMIN_READS = { adminLoad: 1, adminMatrix: 1, adminMonths: 1, adminStatus: 1 };
// Read actions the employee page makes — open, gated only by the private ?user=<slug> link.
const EMP_READS = { empList: 1, empLoad: 1 };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' }
});
const ok = (obj) => json(obj);                                   // verbatim Apps Script output ({ok:true,...})
const fail = (error, status = 200) => json({ ok: false, error }, status);
const fallback = (why) => json({ ok: false, fallback: true, error: why });

/** Constant-time string compare (for the admin password), length-safe. */
export function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GET /api?action=... (the same parameters as the Apps Script API) and POST /api/ingest. */
export async function handle(req, store, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.replace(/\/$/, '').endsWith('/ingest')) return ingest(req, store, env);
  if (req.method !== 'GET') return fail('Reads only.', 405);

  const p = Object.fromEntries(url.searchParams);
  const action = String(p.action || '');
  const snap = await store.get('snapshot', { type: 'json' });

  // ping is public and names nothing private: lets "is fast loading on?" be answered from a browser.
  if (action === 'ping') {
    return ok({ ok: true, ran: true, fast: true, published: !!snap,
      at: (snap && snap.at) || '', employees: snap ? (snap.employees || []).length : 0,
      weeks: snap ? (snap.weeks || []).length : 0, months: snap ? (snap.months || []).length : 0 });
  }
  if (!snap) return fallback('nothing published yet');

  // ---- Employee reads: open, served straight from the snapshot. ----
  if (action === 'empList') {
    return snap.empList ? ok(snap.empList) : fallback('roster not published');
  }
  if (action === 'empLoad') {
    const slug = String(p.slug || '');
    const week = String(p.week || '') || snap.defaultWeek || '';
    const forSlug = (snap.emp || {})[slug];
    const hit = forSlug && forSlug[week];
    return hit ? ok(hit) : fallback('timesheet not published for this person/week');
  }

  // ---- Admin reads: gated by ADMIN_PASSWORD, exactly as proxy.js gates them. ----
  if (ADMIN_READS[action]) {
    const adminPass = env.ADMIN_PASSWORD || '';
    const provided = String(req.headers.get('x-admin-pass') || '');
    if (!adminPass) return fallback('admin password not configured here');   // let the proxy decide
    if (!same(provided, adminPass)) return fail('admin_auth', 401);           // a real refusal, not a fallback
    const a = snap.admin || {};
    if (action === 'adminLoad') return a.load ? ok(a.load) : fallback('admin data not published');
    if (action === 'adminMonths') return a.months ? ok(a.months) : fallback('months not published');
    if (action === 'adminMatrix') {
      const scope = String(p.scope || 'week'), period = String(p.period || '');
      const hit = a.matrix && a.matrix[scope] && a.matrix[scope][period];
      return hit ? ok(hit) : fallback('matrix not published for this period');
    }
    if (action === 'adminStatus') {
      const hit = a.status && a.status[String(p.week || '')];
      return hit ? ok(hit) : fallback('status not published for this week');
    }
  }

  // Unknown or non-read action: let Apps Script handle it.
  return fallback('not served on the fast path');
}

/** POST /api/ingest from Apps Script: {gz: base64(gzip(JSON snapshot))} with Bearer INGEST_SECRET. */
async function ingest(req, store, env) {
  const secret = env.INGEST_SECRET || '';
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (secret.length < 24 || !same(auth, secret)) return fail('Not accepted.', 403);   // fails closed with no/short secret
  let b;
  try { b = await req.json(); } catch (e) { return fail('Bad body.', 400); }
  let snap;
  try { snap = JSON.parse(gunzipSync(Buffer.from(String(b.gz || ''), 'base64')).toString('utf8')); } catch (e) { return fail('Bad payload.', 400); }
  if (!snap || typeof snap !== 'object' || !snap.empList || typeof snap.emp !== 'object' || typeof snap.admin !== 'object') {
    return fail('Bad snapshot.', 400);
  }
  await store.setJSON('snapshot', snap);
  return ok({ ok: true, stored: 'snapshot', employees: (snap.employees || []).length, at: snap.at || 0 });
}
