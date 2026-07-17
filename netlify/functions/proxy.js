// Netlify function: proxy
// Keeps the Apps Script URL + secret on the SERVER so they never reach the browser.
// The pages call /api/proxy (redirected here); this adds the key and forwards to
// Apps Script, returning the JSON.
//
// Env vars (Netlify site settings → Environment variables):
//   GAS_URL     = your Apps Script /exec URL
//   API_SECRET  = the same secret you set in Script Properties

exports.handler = async function (event) {
  const GAS_URL = process.env.GAS_URL;
  const API_SECRET = process.env.API_SECRET;

  if (!GAS_URL || !API_SECRET) {
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  try {
    let upstream;
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
      body.key = API_SECRET;
      upstream = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      const params = new URLSearchParams(event.queryStringParameters || {});
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
