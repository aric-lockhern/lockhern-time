# Apps Script backend

`Code.gs` is the JSON API behind the timesheet. It lives in the Google Apps
Script project bound to the timesheet Google Sheet, **not** on Netlify. This
copy is kept in the repo for version control; the Apps Script editor is the
source of truth for what's deployed.

## Applying an update

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
