# Lockhern Time

Lockhern Digital's timesheet. The data lives in a Google Sheet; a Google Apps Script bound to that
Sheet is the **only writer and the source of truth**. The pages are static and hosted on Netlify.

```
                        Google Sheet  (the database)
                              ▲  │
             writes (POST)    │  │  reads
                              │  ▼
   public/*.html ──▶ /api/proxy ──▶ Apps Script web app  (apps-script/Code.gs)   ← authority
   (Netlify)    │                         │
                │                         └─ publishes a snapshot every 5 min / on every change
                │                            (apps-script/Publish.gs) ──▶ /api/ingest
                └──▶ /api  ──▶ Netlify Function (netlify/functions/api.mjs + lib/fastapi.mjs)
                     reads          served from Netlify Blobs — the FAST read path
```

Reads used to wait on Google's Apps Script web-app front end, which is slow and flaky (measured
3–50 s, with ~2 in 5 requests returning a 404 from `script.googleusercontent.com`; the script itself
runs in milliseconds). The **fast read path** moves reads off that front end without changing what
the tool shows or who can see it.

## Repo map

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | The JSON API and the source of truth. Reads/writes the Sheet. All writes go here. |
| `apps-script/Publish.gs` | **Fast loading**: publishes a snapshot (the verbatim output of every read function) to Netlify Blobs via `/api/ingest`, on a 5-min trigger, after every API write, and on hand edits to the Sheet. |
| `netlify/functions/proxy.js` | The slow path: injects the shared secret and forwards to Apps Script. Gates admin actions behind `ADMIN_PASSWORD`. Unchanged by fast loading. |
| `netlify/functions/api.mjs`, `netlify/lib/fastapi.mjs` | **Fast read API** at `<site>/api` (same parameters as the Apps Script API) served from Netlify Blobs, and `/api/ingest` for the publisher. |
| `public/index.html` | Employee timesheet. |
| `public/admin.html` | Admin dashboard. |
| `tests/` | `node --test` unit + security tests (no network). `npm test`. |
| `tests-ui/page.mjs` | Playwright browser test of the real page against the real function. `npm run test:ui`. |

## How the fast read path works

- **Publisher (`Publish.gs`).** Calls the *same* Code.gs read builders the API uses — `empList`,
  `empLoad` (per active person × the last 12 Fridays), `adminLoad`, `adminMonths`, `adminMatrix`
  (per week and per month with data) and `adminSubmissionStatus` — and stores their byte-for-byte
  output as one gzipped snapshot. It POSTs to `<appBaseUrl>/api/ingest` with
  `Authorization: Bearer <INGEST_SECRET>`. It runs every 5 minutes (time trigger), **immediately
  after any API write** (a saved timesheet, a client/team/assignment/settings change — via
  `publishSoon_` in `handle_`), and on hand edits to a data tab (installable `onEdit`). Nothing is
  sent until both `INGEST_SECRET` (Script Properties) and the App base URL (admin Settings) exist.
- **Function (`fastapi.mjs`).** Serves the snapshot back with the **same access rules** as the
  proxy: employee reads (`empList`, `empLoad`) are open — gated only by the private `?user=<slug>`
  link; admin reads (`adminLoad`, `adminMatrix`, `adminMonths`, `adminStatus`) require the
  `ADMIN_PASSWORD`, checked against the same Netlify env var and `x-admin-pass` header the proxy
  uses. It does **zero** data transformation, so it can't drift from Apps Script. Anything it can't
  positively answer — nothing published yet, a person/week/period not in the snapshot, admin password
  not configured here — returns `{ok:false, fallback:true}` and the page asks Apps Script, which
  stays the authority. A **wrong** admin password is a real `401 admin_auth`, not a fallback.
  `/api?action=ping` reports whether anything is published, how many people, and when (no names).
- **Pages.** Reads try `location.origin + '/api'` first and fall back to `/api/proxy` on
  `fallback`, a non-JSON/404 answer, or a network error; if the function isn't deployed, the fast
  path is turned off for the visit. The Apps Script path retries a flaky read up to 4× and shows a
  "Google is slow" note after 8 s (for the admin it also says *why* the fast path isn't serving the
  request). **Writes always go to Apps Script** via `/api/proxy`.

Because every write republishes at once (strong-consistency Blobs), the fast path never serves data
older than Apps Script would. The 5-minute trigger is a safety net and handles the daily week
rollover.

## One-time setup (fast loading)

1. In the **admin dashboard → Settings**, make sure **App base URL** is set (e.g.
   `https://timetracking.lockherndigital.com`) and saved.
2. In the Sheet, run **Lockhern Time ▸ Fast loading: set up** (the menu appears on open; from the
   Apps Script editor you can also run `fastSetup`). It creates `INGEST_SECRET`, installs the
   triggers, sends a test, and shows the secret with the Netlify step.
3. In **Netlify → Site configuration → Environment variables**, add **`INGEST_SECRET`** with the
   value the dialog showed. (The site also needs `GAS_URL`, `API_SECRET` and `ADMIN_PASSWORD`, which
   already power the proxy.)
4. **Netlify → Deploys → Trigger deploy**, wait for it to finish, then run the menu item again — it
   should say **“Fast loading is on.”**

To check from a browser any time: open `https://<site>/api?action=ping`.

## Known, harmless differences from the slow path

- A change made **outside** the app (editing the Sheet by hand) appears on the fast path within
  seconds via the installable `onEdit`, or within 5 minutes via the trigger — not instantly. Changes
  made **through the app** republish immediately.
- The week and month lists in the snapshot are as of the last publish; they refresh on every change
  and at least every 5 minutes.
- A person, week or period the snapshot doesn't cover (e.g. a very old bookmarked week) is served by
  Apps Script automatically — correct, just not fast for that one request.

## Tests

```bash
npm test        # unit + security suite (no network). Also the Netlify build command: a failing
                # test blocks the deploy.
npm run test:ui # Playwright browser test (Chromium). Not part of the build gate.
```

`npm test` publishes the fixture through the real `Publish.gs` into the real `fastapi.mjs` and asserts
the fast path returns the **same answers** as the Apps Script read functions for every person, week,
month and access kind, plus the security cases (admin password required, employee reads open, unknown
person/key falls back rather than leaking, ingest refuses a wrong/missing/short secret).
