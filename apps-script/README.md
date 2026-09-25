# Apps Script backend

`Code.gs` is the JSON API behind the timesheet. It lives in the Google Apps
Script project bound to the timesheet Google Sheet, **not** on Netlify. This
copy is kept in the repo for version control; the Apps Script editor is the
source of truth for what's deployed.

## Applying an update

### Automatic (GitHub Action)

Once the one-time setup below is done, merging any change to `apps-script/**`
on `main` triggers `.github/workflows/deploy-apps-script.yml`, which pushes the
code and publishes a **new version of the existing web-app deployment** (same
`/exec` URL) via [`clasp`](https://github.com/google/clasp). No manual paste.

**One-time setup** (needs your Google account — do it once):

1. Enable the Apps Script API: <https://script.google.com/home/usersettings> →
   turn **Google Apps Script API** on.
2. Install clasp locally and log in:
   ```bash
   npm install -g @google/clasp@2.4.2
   clasp login          # opens a browser; writes ~/.clasprc.json
   ```
3. Capture the project's manifest so CI can push it:
   ```bash
   clasp clone <SCRIPT_ID>     # Script ID is in Apps Script → Project Settings
   ```
   Copy the generated `appsscript.json` into this `apps-script/` folder and
   commit it. (Don't commit `.clasp.json` / `.clasprc.json` — they're
   gitignored.) Check nothing else in the project needs keeping — `clasp push`
   makes the project match this folder.
4. Find the web-app deployment ID (the one behind your `/exec` URL, **not**
   `@HEAD`):
   ```bash
   clasp deployments
   ```
5. Add three repo secrets under **Settings → Secrets and variables → Actions**:
   - `CLASPRC_JSON` — the full contents of `~/.clasprc.json`
   - `APPS_SCRIPT_ID` — the Script ID
   - `APPS_SCRIPT_DEPLOYMENT_ID` — the deployment ID from step 4

Until those secrets exist the workflow no-ops (no failing runs). The first real
run is the test — watch it under the repo's **Actions** tab.

> **Security:** `CLASPRC_JSON` is an OAuth token for your Google account with
> Apps Script scope. Storing it as an Actions secret lets the workflow modify
> your Apps Script projects. Revoke anytime with `clasp logout` or from your
> Google account's third-party access settings.

### Manual (fallback)

1. Open the timesheet's Apps Script project (Extensions → Apps Script from the
   Sheet, or script.google.com).
2. Replace the contents of `Code.gs` with this file.
3. **Deploy → Manage deployments →** edit the existing Web app deployment and
   publish a **new version** (same `/exec` URL). If you create a brand-new
   deployment instead, update `GAS_URL` in Netlify to the new URL.

No Script Properties or Netlify env vars change. `API_SECRET` / `GAS_URL` stay
as they are.

## Daily logging (2026 update)

- The `Entries` sheet gains a **`date`** column, added automatically on the
  first request after deploy. Existing rows are left as-is and treated as a
  whole-week total shown under that week's Friday.
- `empSave` is now a **draft** — it stores hours per client per day and does
  **not** mark the week submitted.
- `empSubmit` marks the week submitted. Weeks stay editable; re-submitting
  updates the timestamp.
- Submission status is driven by an explicit `__submitted__` marker row, so
  saving a draft no longer counts as "submitted."
- Reports and capacity roll the daily cells up to weekly totals, so the admin
  dashboard is unchanged.

The front-end that calls this API is `public/index.html` (employee) and
`public/admin.html` (admin), served by Netlify.
