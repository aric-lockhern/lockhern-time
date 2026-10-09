/**
 * FAST LOADING — publishes what the pages read to Netlify, so reads don't wait on Google's
 * Apps Script web-app front end (measured slow: requests 3-50 s with random 404s; the script
 * itself runs in milliseconds). Lives in the same project as Code.gs (one global scope), so it
 * calls Code.gs's own read builders — the fast path can't drift from what Apps Script returns.
 * -----------------------------------------------------------------------------
 * Every 5 minutes (time trigger) `publishAll` builds ONE snapshot and POSTs it, gzipped, to
 * <appBaseUrl>/api/ingest (netlify/functions/api.mjs) with Authorization: Bearer <INGEST_SECRET>:
 *   - empList() — the landing-page roster
 *   - empLoad(slug, week) for every active person × the last 12 Fridays
 *   - adminLoad(), adminMonths(), adminMatrix(period, scope) for those weeks and each month with
 *     data, and adminSubmissionStatus(week) for those weeks
 * Each value is the byte-for-byte output of the Code.gs read function. The Netlify function does
 * no transformation: it serves these back, with the SAME access rules (employee reads open by the
 * private ?user=<slug> link; admin reads gated by ADMIN_PASSWORD).
 *
 * A write through the API (a saved timesheet, a client/team/assignment/settings change) refreshes
 * the snapshot at once (publishSoon_ from handle_), and an installable onEdit refreshes it when the
 * Sheet is edited by hand — so the fast path never serves data older than Apps Script would. The
 * page asks Apps Script whenever the fast path can't positively answer (a person/week/period not in
 * the snapshot, nothing published yet).
 *
 * Secret: Script Properties INGEST_SECRET must equal the Netlify env var INGEST_SECRET (the function
 * refuses everything when its copy is missing or shorter than 24 chars). The publish target is the
 * App base URL from admin Settings. Nothing is sent until both exist. Run the Sheet menu
 * "Lockhern Time ▸ Fast loading: set up" once to create the secret, install the triggers and test.
 */
var PUB_BUDGET_MS = 4 * 60 * 1000;
var PUB_WEEKS = 12;                       // how many recent Fridays to publish (covers both pages' dropdowns)

function pubSecret_() { return PropertiesService.getScriptProperties().getProperty('INGEST_SECRET') || ''; }
function pubBaseUrl_() {
  try { return String(getSettings_().appBaseUrl || '').replace(/\/+$/, ''); } catch (e) { return ''; }
}
function pubUrl_() { var b = pubBaseUrl_(); return b ? b + '/api/ingest' : ''; }
function pubOn_() { return !!(pubSecret_() && pubUrl_()); }

function hexDigest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))
    .map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join('');
}

/** A signature that changes whenever anything the reads depend on changes — plus today's Friday,
 *  so the day's rollover republishes even with no data change. Cheap (a few getValues). */
function pubVersion_() {
  var ss = SpreadsheetApp.getActive();
  var parts = [fridayOf_(new Date())];
  [DB.TEAM, DB.CLIENTS, DB.ASSIGN, DB.SETTINGS, DB.ENTRIES,
   DB.CHANNELS, DB.REVENUE, DB.SPLIT, DB.OWNERS].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1) { parts.push(name + ':0'); return; }
    parts.push(name + ':' + hexDigest_(JSON.stringify(sh.getDataRange().getValues())));
  });
  return hexDigest_(parts.join('~'));
}

/** Builds the whole snapshot from a single set of sheet reads, reusing Code.gs's own builders. */
function buildSnapshot_() {
  var ss = SpreadsheetApp.getActive();
  bustCache_();                                     // force the cached read functions to recompute fresh
  var entries = rows_(ss, DB.ENTRIES);
  var team = rows_(ss, DB.TEAM);
  var clients = rows_(ss, DB.CLIENTS);
  var assign = rows_(ss, DB.ASSIGN);
  var activeTeam = team.filter(function (t) { return t.active !== false; });
  var weeks = recentFridays_(PUB_WEEKS);
  var months = adminMonths();

  var emp = {}, slugs = [];
  activeTeam.forEach(function (t) {
    slugs.push(t.slug);
    var byWeek = {};
    weeks.forEach(function (wk) { byWeek[wk] = empLoadFromRows_(entries, team, clients, assign, t.slug, wk); });
    emp[t.slug] = byWeek;
  });

  var matrixWeek = {}, matrixMonth = {}, status = {};
  weeks.forEach(function (wk) {
    matrixWeek[wk] = matrixFromRows_(entries, team, clients, wk, 'week');
    status[wk] = submissionStatusFromRows_(entries, activeTeam, wk);
  });
  months.forEach(function (m) { matrixMonth[m] = matrixFromRows_(entries, team, clients, m, 'month'); });

  return {
    at: Date.now(),
    defaultWeek: fridayOf_(new Date()),
    weeks: weeks,
    months: months,
    employees: slugs,
    empList: empList(),
    emp: emp,
    admin: {
      load: adminLoad(),
      months: {ok: true, months: months},
      matrix: {week: matrixWeek, month: matrixMonth},
      status: status,
      revenue: adminRevenue()
    }
  };
}

/** POSTs one snapshot; returns '' or the reason it failed. */
function pubPost_(snapshot) {
  var gz = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(snapshot), 'application/json')).getBytes());
  var res = UrlFetchApp.fetch(pubUrl_(), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + pubSecret_() },
    payload: JSON.stringify({ gz: gz })
  });
  var code = res.getResponseCode(), body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  return (code === 200 && body.ok) ? '' : 'HTTP ' + code + (body.error ? ': ' + body.error : '');
}

/**
 * Builds and sends the snapshot, serialized against overlapping runs by a CacheService flag. If a
 * run is already going, this marks it dirty so that run repeats with the latest data. `force` skips
 * the "unchanged since last publish" check (used after a write, where a change definitely happened).
 */
function pubRun_(force) {
  if (!pubOn_()) return;
  var cache = CacheService.getScriptCache();
  if (cache.get('pub_running')) { cache.put('pub_dirty', '1', 600); return; }
  cache.put('pub_running', '1', 300);
  try {
    var props = PropertiesService.getScriptProperties(), started = Date.now();
    do {
      cache.remove('pub_dirty');
      var version = pubVersion_();
      if (!force && props.getProperty('PUB_VER') === version) return;   // nothing changed since last publish
      force = false;                                                     // only the first pass may be forced
      var err = pubPost_(buildSnapshot_());
      if (err) { console.log('Fast loading: snapshot not accepted: ' + err); return; }
      props.setProperty('PUB_VER', version);
    } while (cache.get('pub_dirty') && Date.now() - started < PUB_BUDGET_MS);
    console.log('Fast loading: snapshot published.');
  } finally {
    cache.remove('pub_running');
  }
}

/** Time trigger (every 5 minutes): publish only when something changed. */
function publishAll() { pubRun_(false); }

/** Right after a write (called from handle_). Forces a fresh publish. Never throws. */
function publishSoon_() {
  try { pubRun_(true); } catch (e) { console.log('Fast loading: could not publish now: ' + e); }
}

/** Installable onEdit: a hand edit to a data tab reaches the fast path within seconds. */
function onEditPublish(e) {
  var name = '';
  try { name = e && e.range ? e.range.getSheet().getName() : ''; } catch (x) {}
  if (name === DB.TEAM || name === DB.CLIENTS || name === DB.ASSIGN || name === DB.ENTRIES || name === DB.SETTINGS) {
    publishSoon_();
  }
}

// ============================================================
//  SHEET MENU — one-time setup and a manual publish
// ============================================================
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Lockhern Time')
      .addItem('Fast loading: set up', 'fastSetup')
      .addItem('Fast loading: publish now', 'fastPublishNow')
      .addToUi();
  } catch (e) { /* no UI in some execution contexts */ }
}

function fastPublishNow() {
  var ui = SpreadsheetApp.getUi();
  if (!pubOn_()) { ui.alert('Fast loading isn’t set up yet. Run "Fast loading: set up" first.'); return; }
  publishSoon_();
  ui.alert('Published the current snapshot to the fast read path.');
}

/** Creates the shared secret, shows it for Netlify, installs the triggers, and tests the link. */
function fastSetup() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  if (!pubBaseUrl_()) {
    ui.alert('Set the App base URL first.\n\nOpen the admin dashboard → Settings → App base URL ' +
      '(e.g. https://timetracking.lockherndigital.com) and save. Then run this again.');
    return;
  }
  var secret = pubSecret_();
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('INGEST_SECRET', secret);
  }
  var have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('publishAll') < 0) ScriptApp.newTrigger('publishAll').timeBased().everyMinutes(5).create();
  if (have.indexOf('onEditPublish') < 0) ScriptApp.newTrigger('onEditPublish').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();

  var test = '';
  try { test = pubPost_(buildSnapshot_()); if (!test) PropertiesService.getScriptProperties().setProperty('PUB_VER', pubVersion_()); }
  catch (e) { test = String(e && e.message ? e.message : e); }

  ui.showModalDialog(HtmlService.createHtmlOutput(
    '<div style="font:14px Arial;padding:4px">' +
    (test
      ? '<p><b>One step left, in Netlify:</b> Site configuration &gt; Environment variables &gt; Add a variable</p>' +
        '<p>Key: <b>INGEST_SECRET</b><br>Value:</p><input style="width:100%;padding:6px" value="' + secret + '" onclick="this.select()" readonly>' +
        '<p>Then Deploys &gt; Trigger deploy, wait for it to finish, and run this menu item again.</p>' +
        '<p style="color:#64748b">Test send: ' + esc_(test) + '</p>'
      : '<p><b>Fast loading is on.</b> The pages now read from Netlify and fall back to Apps Script only ' +
        'when the snapshot can’t answer. Every change republishes within seconds; a safety refresh runs every 5 minutes.</p>') +
    '</div>').setWidth(560).setHeight(test ? 300 : 160), 'Fast loading');
}
