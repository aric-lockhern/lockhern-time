# Lockhern Time — guide for Claude Code

Timesheet app. Read `README.md` for the full picture. The invariants below must hold for any change.

## Architecture
- **Google Sheet** = database. **`apps-script/Code.gs`** = the JSON API, the **only writer**, and the
  **authority** for access. The Netlify pages (`public/*.html`) call it through **`/api/proxy`**.
- **Fast read path** (`apps-script/Publish.gs` + `netlify/functions/api.mjs` + `netlify/lib/fastapi.mjs`):
  Apps Script publishes a snapshot of the read functions' output to Netlify Blobs; the pages read it
  from `<site>/api` and fall back to `/api/proxy` whenever it can't answer. It only changes **where
  reads are served**, never **what** they return or **who** may see them.

## Invariants (do not break)
1. **Access is unchanged.** Employee reads (`empList`, `empLoad`) are open — the private
   `?user=<slug>` link is the gate. Admin reads (`adminLoad`, `adminMatrix`, `adminMonths`,
   `adminStatus`) require `ADMIN_PASSWORD` (`x-admin-pass`), checked the same way in `proxy.js` and
   `fastapi.mjs`. Writes go only to Apps Script.
2. **No drift.** The fast path returns the **verbatim** output of Code.gs builders. `Publish.gs`
   calls those builders (`empLoadFromRows_`, `matrixFromRows_`, `submissionStatusFromRows_`,
   `empList`, `adminLoad`, `adminMonths`); `fastapi.mjs` does zero transformation. If you change a
   read's shape, the snapshot changes with it — keep `tests/fastapi.test.mjs` green (it compares
   fast answers to the live functions for every person/week/month/access kind).
3. **Fail safe.** Anything the fast path can't positively verify → `{ok:false, fallback:true}` and
   the page asks Apps Script. A wrong admin password is a real `401 admin_auth`, not a fallback.
   `/api/ingest` refuses a missing/short (<24 char)/mismatched `INGEST_SECRET`.
4. **Secrets stay out of the repo.** `INGEST_SECRET` (Script Properties + Netlify env, same value),
   `ADMIN_PASSWORD`, `API_SECRET`, `GAS_URL` live only in Script Properties / Netlify env.

## Where to edit
- Backend + publisher: `apps-script/Code.gs`, `apps-script/Publish.gs`. CI (`.github/workflows/
  deploy-apps-script.yml`) pushes both via clasp on a push to `main` touching `apps-script/**`
  (`.claspignore` whitelists `Code.gs` + `Publish.gs` + `appsscript.json`).
- Fast read API: `netlify/lib/fastapi.mjs` (logic, tested directly) and `netlify/functions/api.mjs`
  (thin v2 wrapper at `/api` + `/api/ingest`).
- Pages: `public/index.html`, `public/admin.html` (plain inline ES5-ish JS, one file each).

## Tests
`npm test` (node, no network — also the Netlify build gate) and `npm run test:ui` (Playwright).
Always run `npm test` before pushing.
