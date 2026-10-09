// Netlify function: proxy
// Keeps the Apps Script URL + secret on the SERVER so they never reach the browser.
// The pages call /api/proxy (redirected here); this adds the key and forwards to
// Apps Script, returning the JSON.
//
// Env vars (Netlify site settings → Environment variables):
//   GAS_URL        = your Apps Script /exec URL
//   API_SECRET     = the same secret you set in Script Properties
//   ADMIN_PASSWORD = password that gates the admin console (e.g. founders)
//
// Employee actions (empLoad/empSave/empSubmit/empUnassign) are open — they're
// gated by each person's private ?user=<slug> link. Admin actions require the
// ADMIN_PASSWORD, sent by the admin page in the `x-admin-pass` header.

var ADMIN_ACTIONS = {
  adminLoad: 1, adminReport: 1, adminMatrix: 1, adminMonths: 1, adminStatus: 1,
  addClient: 1, toggleClient: 1, addMember: 1, updateMember: 1, setAssignments: 1,
  loadSettings: 1, saveSettings: 1, sendTest: 1, sendWelcome: 1,
  adminRevenue: 1, saveChannels: 1, saveClientRevenue: 1, saveChannelOwners: 1
};

exports.handler = async function (event) {
  const GAS_URL = process.env.GAS_URL;
  const API_SECRET = process.env.API_SECRET;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

  if (!GAS_URL || !API_SECRET) {
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  // Parse the POST body once so we can read the action for the auth check.
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  }
  const params = new URLSearchParams(event.queryStringParameters || {});
  const action = event.httpMethod === 'POST' ? String(body.action || '') : String(params.get('action') || '');

  // Gate admin actions behind ADMIN_PASSWORD (sent in the x-admin-pass header).
  if (ADMIN_ACTIONS[action]) {
    const headers = event.headers || {};
    const provided = String(headers['x-admin-pass'] || headers['X-Admin-Pass'] || '');
    if (!ADMIN_PASSWORD || provided !== ADMIN_PASSWORD) {
      return json(401, { ok: false, error: 'admin_auth' });
    }
  }

  try {
    let upstream;
    if (event.httpMethod === 'POST') {
      body.key = API_SECRET;
      upstream = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      params.set('key', API_SECRET);
      upstream = await fetch(GAS_URL + '?' + params.toString(), { method: 'GET' });
    }

    const text = await upstream.text();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return json(502, { ok: false, error: 'proxy_error', detail: String(err && err.message || err) });
  }
};

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
