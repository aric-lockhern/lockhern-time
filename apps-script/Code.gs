/**
 * ============================================================
 *  LOCKHERN TIME TRACKER — API backend (for the Netlify front-end)
 * ------------------------------------------------------------
 *  JSON-only API. The Netlify-hosted pages (public/index.html and
 *  public/admin.html) call it through /api/proxy, which injects the
 *  shared secret and forwards the request here.
 *
 *  DAILY LOGGING (2026 update)
 *  ---------------------------
 *  Hours are now stored PER CLIENT PER DAY. The Entries sheet gains a
 *  `date` column (added automatically on first run — existing rows are
 *  left untouched and treated as a whole-week total under that week's
 *  Friday). Saving a timesheet is now a DRAFT (empSave) and does NOT
 *  mark the week submitted; a separate empSubmit marks it submitted.
 *  Weeks stay editable after submitting (re-submit updates the stamp).
 *
 *  SETUP
 *   1. Script Properties > API_SECRET = <a long random string>
 *      (or run setSecret_() once with your value).
 *   2. Deploy > New deployment > Web app.
 *        Execute as: Me.   Who has access: Anyone.
 *      Copy the /exec URL.
 *   3. Put the /exec URL (GAS_URL) and the same secret (API_SECRET)
 *      into the Netlify site's environment variables.
 *
 *  Every request must include the secret as ?key=... (GET) or in the
 *  JSON body (POST). Requests without the right key are rejected.
 * ============================================================
 */

var DB = {
  CLIENTS: 'Clients',
  TEAM: 'Team',
  ASSIGN: 'Assignments',
  ENTRIES: 'Entries',
  SETTINGS: 'Settings',   // key | value — reminder config lives here
  // Account ownership + revenue (who manages which channel of a client, and the revenue that implies)
  CHANNELS: 'Channels',   // id | name | active
  REVENUE: 'Revenue',     // clientId | monthly | notes   (one row per client that has a retainer)
  SPLIT: 'RevenueSplit',  // clientId | channelId | amount (dollars allocated to a channel)
  OWNERS: 'ChannelOwners' // clientId | channelId | userId (explicit owner; empty ⇒ the client's assignees)
};
var DEFAULT_FT_HOURS = 40;
var SUBMIT_MARKER = '__submitted__';   // sentinel clientId marking an explicit submission
var ENTRIES_HEADER = ['id', 'userId', 'weekEnding', 'clientId', 'hours', 'updatedAt', 'date'];

// ---- Settings (reminder config), stored on a "Settings" tab as key/value rows ----
function ensureSettings_(ss) {
  var sh = ss.getSheetByName(DB.SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(DB.SETTINGS);
    sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]).setFontWeight('bold');
    var defaults = [
      ['remindersEnabled', 'yes'],
      ['ccEmail', ''],
      ['appBaseUrl', ''],          // e.g. https://timetracking.lockherndigital.com
      ['fridayHour', '9'],         // 0-23, Friday nudge to everyone
      ['mondayHour', '10'],        // 0-23, Monday chase to overdue
      ['fromName', 'Lockhern Digital']
    ];
    sh.getRange(2, 1, defaults.length, 2).setValues(defaults);
  }
  return sh;
}
function getSettings_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ensureSettings_(ss);
  var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  var m = {};
  for (var i = 1; i < v.length; i++) if (v[i][0]) m[String(v[i][0])] = v[i][1];
  return {
    remindersEnabled: String(m.remindersEnabled || 'yes').toLowerCase() === 'yes',
    ccEmail: String(m.ccEmail || '').trim(),
    appBaseUrl: String(m.appBaseUrl || '').trim().replace(/\/+$/, ''),
    fridayHour: parseInt(m.fridayHour, 10),
    mondayHour: parseInt(m.mondayHour, 10),
    fromName: String(m.fromName || 'Lockhern Digital').trim()
  };
}
function saveSettings_(patch) {
  var ss = SpreadsheetApp.getActive();
  var sh = ensureSettings_(ss);
  var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  var rowByKey = {};
  for (var i = 1; i < v.length; i++) if (v[i][0]) rowByKey[String(v[i][0])] = i + 1;
  Object.keys(patch).forEach(function (k) {
    if (rowByKey[k]) sh.getRange(rowByKey[k], 2).setValue(patch[k]);
    else sh.appendRow([k, patch[k]]);
  });
  return getSettings_();
}

// ---- Entries schema: ensure the sheet + the `date` column exist. Idempotent. ----
function ensureEntriesSchema_(ss) {
  var sh = ss.getSheetByName(DB.ENTRIES);
  if (!sh) {
    sh = ss.insertSheet(DB.ENTRIES);
    sh.getRange(1, 1, 1, ENTRIES_HEADER.length).setValues([ENTRIES_HEADER]).setFontWeight('bold');
    return sh;
  }
  if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) {
    sh.getRange(1, 1, 1, ENTRIES_HEADER.length).setValues([ENTRIES_HEADER]).setFontWeight('bold');
    return sh;
  }
  var lastCol = sh.getLastColumn();
  var have = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x); });
  if (have.indexOf('date') < 0) {
    sh.getRange(1, lastCol + 1).setValue('date');
  }
  return sh;
}

// ---- Account ownership + revenue schema. Idempotent; seeds the starter channels once. ----
function ensureTab_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  }
  return sh;
}
function ensureRevenueTabs_(ss) {
  if (!ss.getSheetByName(DB.CHANNELS)) {
    var sh = ss.insertSheet(DB.CHANNELS);
    sh.getRange(1, 1, 1, 3).setValues([['id', 'name', 'active']]).setFontWeight('bold');
    sh.getRange(2, 1, 3, 3).setValues([
      [Utilities.getUuid(), 'AI SEO', true],
      [Utilities.getUuid(), 'Paid Search', true],
      [Utilities.getUuid(), 'Meta', true]
    ]);
  }
  ensureTab_(ss, DB.REVENUE, ['clientId', 'monthly', 'notes']);
  ensureTab_(ss, DB.SPLIT, ['clientId', 'channelId', 'amount']);
  ensureTab_(ss, DB.OWNERS, ['clientId', 'channelId', 'userId']);
}

// ---- one-time helper to set the secret from the editor ----
function setSecret_() {
  PropertiesService.getScriptProperties().setProperty('API_SECRET', 'CHANGE_ME_to_a_long_random_string');
}
function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('API_SECRET') || '';
}

// ---- lightweight cache for read-heavy admin endpoints (~90s) ----
// Version-namespaced: bustCache_() invalidates every cached entry at once.
function cacheVer_() {
  var c = CacheService.getScriptCache();
  var v = c.get('cacheVer');
  if (!v) { v = newToken_(); c.put('cacheVer', v, 21600); }
  return v;
}
function bustCache_() {
  CacheService.getScriptCache().put('cacheVer', newToken_(), 21600);
}
function newToken_() { return String(Date.now()) + '-' + Math.random().toString(36).slice(2); }
function cacheGet_(key) {
  try { var s = CacheService.getScriptCache().get(cacheVer_() + '|' + key); return s ? JSON.parse(s) : null; }
  catch (e) { return null; }
}
function cachePut_(key, obj, ttl) {
  try { CacheService.getScriptCache().put(cacheVer_() + '|' + key, JSON.stringify(obj), ttl || 90); }
  catch (e) { /* value too big or cache unavailable — just skip caching */ }
}

// ============================================================
//  ROUTING  — everything comes in as ?action=...
// ============================================================
function doGet(e) {
  return handle_(e, (e && e.parameter) || {});
}
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = (e && e.parameter) || {}; }
  return handle_(e, body);
}

// Actions that change what the reads return. After one succeeds, the fast-loading
// snapshot is refreshed at once (Publish.gs publishSoon_) so the Netlify read path
// never serves data older than Apps Script would. A no-op when fast loading is off.
var MUTATING_ACTIONS = {
  empSave: 1, empSubmit: 1, empUnassign: 1,
  addClient: 1, toggleClient: 1, addMember: 1, updateMember: 1, setAssignments: 1,
  saveSettings: 1,
  saveChannels: 1, saveClientRevenue: 1, saveChannelOwners: 1
};

function handle_(e, p) {
  // Auth
  var provided = String(p.key || '');
  if (!getSecret_() || provided !== getSecret_()) {
    return json_({ok: false, error: 'unauthorized'});
  }
  var action = String(p.action || '');
  try {
    ensureEntriesSchema_(SpreadsheetApp.getActive());
    var out = route_(action, p);
    // Refresh the fast-loading snapshot after a successful write (runs after the
    // action's own lock is released; safe no-op when fast loading isn't set up).
    if (MUTATING_ACTIONS[action] && out && out.ok && typeof publishSoon_ === 'function') {
      try { publishSoon_(); } catch (pe) { /* publishing must never fail the write */ }
    }
    return json_(out);
  } catch (err) {
    return json_({ok: false, error: 'server_error', detail: String(err && err.message || err)});
  }
}

// Returns the plain result object for an action (json_ is applied by handle_).
function route_(action, p) {
  switch (action) {
    case 'empLoad':   return empLoad(p.slug, p.week || null);
    case 'empList':   return empList();
    case 'empSave':   return empSave(p.slug, p.week, p.days || {}, p.assign || []);
    case 'empSubmit': return empSubmit(p.slug, p.week, p.days || null, p.assign || []);
    case 'empUnassign': return empUnassign(p.slug, p.clientIds || (p.clientId ? [p.clientId] : []));
    case 'adminLoad': return adminLoad();
    case 'adminReport': return adminReport(p.period, p.scope, p.userId);
    case 'adminMatrix': return adminMatrix(p.period, p.scope);
    case 'adminMonths': return {ok: true, months: adminMonths()};
    case 'adminStatus': return adminSubmissionStatus(p.week);
    case 'addClient': return adminAddClient(p.name);
    case 'toggleClient': return adminToggleClient(p.id, p.active);
    case 'addMember': return adminAddMember(p.name, p.type, p.weeklyHours, p.email);
    case 'updateMember': return adminUpdateMember(p.id, p.patch || {});
    case 'setAssignments': return adminSetAssignments(p.clientId, p.userIds || []);
    case 'loadSettings': return {ok: true, settings: getSettings_()};
    case 'saveSettings': return adminSaveSettings(p.patch || {});
    case 'sendTest': return adminSendTest(p.slug);
    case 'sendWelcome': return adminSendWelcome(p.slug);
    case 'adminRevenue': return adminRevenue();
    case 'saveChannels': return adminSaveChannels(p.channels || []);
    case 'saveClientRevenue': return adminSaveClientRevenue(p.clientId, p.monthly, p.notes, p.splits || {});
    case 'saveChannelOwners': return adminSaveChannelOwners(p.clientId, p.channelId, p.userIds || []);
    default: return {ok: false, error: 'unknown_action', action: action};
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  EMPLOYEE
// ============================================================
// Public roster for the landing-page picker (active team, name + slug).
function empList() {
  var hit = cacheGet_('empList'); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  var people = rows_(ss, DB.TEAM)
    .filter(function (t) { return t.active !== false; })
    .map(function (t) { return {name: t.name, slug: t.slug}; })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var res = {ok: true, people: people};
  cachePut_('empList', res);
  return res;
}

function empLoad(slug, week) {
  var ss = SpreadsheetApp.getActive();
  return empLoadFromRows_(rows_(ss, DB.ENTRIES), rows_(ss, DB.TEAM),
    rows_(ss, DB.CLIENTS), rows_(ss, DB.ASSIGN), slug, week);
}

/** The body of empLoad, working from already-read rows. Pure (no sheet access), so the
 *  publisher can rebuild every person's week from a single set of reads, while the live
 *  empLoad above calls it the same way — the two can't drift. Behavior is identical to the
 *  original empLoad: same user lookup (first active match), same assignment map, same shape. */
function empLoadFromRows_(entryRows, teamRows, clientRows, assignRows, slug, week) {
  var user = null;
  for (var i = 0; i < teamRows.length; i++) {
    if (teamRows[i].slug === slug && teamRows[i].active !== false) { user = teamRows[i]; break; }
  }
  if (!user) return {ok: false, error: 'unknown_user'};

  var wk = week || fridayOf_(new Date());
  var assignedIds = {};
  assignRows.forEach(function (a) { if (String(a.userId) === String(user.id)) assignedIds[String(a.clientId)] = true; });
  var hours = entriesForRows_(entryRows, user.id, wk);       // { clientId: { 'yyyy-mm-dd': hours } }
  var allActive = clientRows.filter(function (c) { return c.active !== false; });

  // Show a client row if it's assigned to this user OR they've already logged time
  // against it this week (so a self-added client stays put mid-week).
  var show = {};
  allActive.forEach(function (c) { if (assignedIds[c.id]) show[c.id] = true; });
  Object.keys(hours).forEach(function (cid) { if (cid !== 'internal' && cid !== 'adhoc') show[cid] = true; });

  var clients = allActive.filter(function (c) { return show[c.id]; })
    .map(function (c) { return {id: c.id, name: c.name, assigned: !!assignedIds[c.id]}; });
  clients.sort(function (a, b) { return a.name.localeCompare(b.name); });
  clients.push({id: 'internal', name: 'Internal', assigned: true});
  clients.push({id: 'adhoc', name: 'Ad hoc support (stepped in on a client you don’t own)', assigned: true});
  clients.push({id: 'pto', name: 'PTO / time off', assigned: true, pto: true});

  return {
    ok: true,
    user: {name: user.name, slug: user.slug, weeklyHours: user.weeklyHours, type: user.type},
    week: wk,
    weeks: recentFridays_(10),
    clients: clients,
    allClients: allActive.map(function (c) { return {id: c.id, name: c.name}; })
                         .sort(function (a, b) { return a.name.localeCompare(b.name); }),
    hours: hours,
    submitted: isSubmittedRows_(entryRows, user.id, wk)
  };
}

/** Add (clientId,userId) assignment rows the user doesn't already have. Runs inside
 *  a caller's lock. Only active, real clients (not internal/adhoc) are assignable. */
function selfAssign_(ss, userId, clientIds) {
  if (!clientIds || !clientIds.length) return 0;
  var uid = String(userId);
  var valid = {};
  rows_(ss, DB.CLIENTS).forEach(function (c) { if (c.active !== false) valid[String(c.id)] = true; });
  var sh = ss.getSheetByName(DB.ASSIGN);
  if (!sh) return 0;
  var data = sh.getDataRange().getValues();
  var existing = {};
  for (var r = 1; r < data.length; r++) existing[String(data[r][0]) + '|' + String(data[r][1])] = true;
  var appends = [];
  clientIds.forEach(function (cid) {
    cid = String(cid);
    if (cid && cid !== 'internal' && cid !== 'adhoc' && valid[cid] && !existing[cid + '|' + uid]) {
      appends.push([cid, uid]); existing[cid + '|' + uid] = true;
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, 2).setValues(appends);
  return appends.length;
}

/** Remove the caller's OWN assignment rows for the given clients. Scoped to this
 *  user only — never touches anyone else's assignments. Hours are left intact. */
function empUnassign(slug, clientIds) {
  var ss = SpreadsheetApp.getActive();
  var user = teamBySlug_(ss, slug);
  if (!user) return {ok: false, error: 'unknown_user'};
  if (!clientIds || !clientIds.length) return {ok: true, removed: 0};
  var uid = String(user.id);
  var drop = {};
  clientIds.forEach(function (c) { drop[String(c)] = true; });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(DB.ASSIGN);
    if (!sh || sh.getLastRow() < 2) return {ok: true, removed: 0};
    var data = sh.getDataRange().getValues();
    var keep = [data[0]];
    var removed = 0;
    for (var r = 1; r < data.length; r++) {
      var cid = String(data[r][0]), u = String(data[r][1]);
      if (u === uid && drop[cid]) { removed++; continue; }   // caller's own assignment for a dropped client
      keep.push(data[r]);
    }
    if (removed) {
      sh.clearContents();
      sh.getRange(1, 1, keep.length, keep[0].length).setValues(keep);
    }
    return {ok: true, removed: removed};
  } finally {
    lock.releaseLock();
  }
}

/** Submitted = an explicit submission marker exists for this user + week. */
function isSubmitted_(ss, userId, week) {
  return isSubmittedRows_(rows_(ss, DB.ENTRIES), userId, week);
}
function isSubmittedRows_(entryRows, userId, week) {
  var uid = String(userId), wk = weekStr_(week);
  for (var i = 0; i < entryRows.length; i++) {
    var e = entryRows[i];
    if (String(e.userId) === uid && weekStr_(e.weekEnding) === wk && String(e.clientId) === SUBMIT_MARKER) return true;
  }
  return false;
}

/**
 * Draft save. Upserts hours per (client, day). Does NOT submit.
 * days = { clientId: { 'yyyy-mm-dd': hours } }
 */
function empSave(slug, weekEnding, days, assign) {
  var ss = SpreadsheetApp.getActive();
  var user = teamBySlug_(ss, slug);
  if (!user) return {ok: false, error: 'unknown_user'};
  var wk = String(weekEnding).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wk)) return {ok: false, error: 'bad_week'};

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ensureEntriesSchema_(ss);
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    writeDays_(sh, user, wk, days || {}, stamp);
    var assigned = selfAssign_(ss, user.id, assign || []);
    return {ok: true, savedAt: stamp, submitted: isSubmitted_(ss, user.id, wk), assigned: assigned};
  } finally {
    lock.releaseLock();
  }
}

/** Explicit submit. Optionally saves the latest cells first, then marks the week submitted. */
function empSubmit(slug, weekEnding, days, assign) {
  var ss = SpreadsheetApp.getActive();
  var user = teamBySlug_(ss, slug);
  if (!user) return {ok: false, error: 'unknown_user'};
  var wk = String(weekEnding).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wk)) return {ok: false, error: 'bad_week'};

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ensureEntriesSchema_(ss);
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    if (days) writeDays_(sh, user, wk, days, stamp);
    var assigned = selfAssign_(ss, user.id, assign || []);
    setSubmitted_(sh, String(user.id), wk, stamp);
    return {ok: true, savedAt: stamp, submitted: true, assigned: assigned};
  } finally {
    lock.releaseLock();
  }
}

/**
 * Shared upsert used by empSave/empSubmit. No lock (callers hold it).
 * Migrates any legacy dateless rows for this user+week onto the week's Friday
 * so they upsert cleanly and never double-count.
 */
function writeDays_(sh, user, wk, days, stamp) {
  var data = sh.getDataRange().getValues();
  var uid = String(user.id);
  var idx = {};   // 'clientId|date' -> 0-based row index in data
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][1]) !== uid) continue;
    if (weekStr_(data[r][2]) !== wk) continue;
    var cid = String(data[r][3]);
    if (cid === SUBMIT_MARKER) continue;
    var dcell = data[r][6];
    var dstr = dcell ? weekStr_(dcell) : '';
    if (!dstr) {                       // legacy total -> pin to Friday, in place
      dstr = wk;
      sh.getRange(r + 1, 7).setValue(wk);
      data[r][6] = wk;
    }
    idx[cid + '|' + dstr] = r;
  }

  var appends = [];
  Object.keys(days).forEach(function (cid) {
    var perDay = days[cid] || {};
    Object.keys(perDay).forEach(function (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;   // ignore malformed dates
      var h = parseFloat(perDay[date]);
      if (isNaN(h) || h < 0) h = 0;
      var key = cid + '|' + date;
      if (idx.hasOwnProperty(key)) {
        var rr = idx[key];
        sh.getRange(rr + 1, 5).setValue(h);
        sh.getRange(rr + 1, 6).setValue(stamp);
      } else if (h > 0) {
        appends.push([Utilities.getUuid(), uid, wk, cid, h, stamp, date]);
      }
    });
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, ENTRIES_HEADER.length).setValues(appends);
}

/** Create or refresh the submission marker row for a user+week. */
function setSubmitted_(sh, uid, wk, stamp) {
  var data = sh.getDataRange().getValues();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][1]) === uid && weekStr_(data[r][2]) === wk && String(data[r][3]) === SUBMIT_MARKER) {
      sh.getRange(r + 1, 6).setValue(stamp);
      return;
    }
  }
  sh.appendRow([Utilities.getUuid(), uid, wk, SUBMIT_MARKER, 1, stamp, '']);
}

// ============================================================
//  ADMIN
// ============================================================
function adminLoad() {
  var hit = cacheGet_('adminLoad'); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  var entryRows = rows_(ss, DB.ENTRIES);        // read Entries ONCE for both status + matrix0
  var team = rows_(ss, DB.TEAM);
  var clientRows = rows_(ss, DB.CLIENTS);
  var weeks = recentFridays_(12);
  var statusWeek = fridayOf_(new Date());
  var defaultPeriod = weeks.length > 1 ? weeks[1] : weeks[0];   // previous completed week (admin default)
  var res = {
    ok: true,
    clients: clientRows,
    team: team,
    assignments: rows_(ss, DB.ASSIGN),
    weeks: weeks,
    statusWeek: statusWeek,
    status: submissionStatusFromRows_(entryRows, team.filter(function (t) { return t.active !== false; }), statusWeek),
    settings: getSettings_(),
    defaultPeriod: defaultPeriod,
    matrix0: matrixFromRows_(entryRows, team, clientRows, defaultPeriod, 'week')   // lets the admin boot in ONE call
  };
  cachePut_('adminLoad', res);
  return res;
}

function adminAddClient(name) {
  var ss = SpreadsheetApp.getActive();
  if (!String(name).trim()) return {ok: false, error: 'empty'};
  addClient_(ss, String(name).trim());
  bustCache_();
  return adminLoad();
}
function adminToggleClient(id, active) {
  update_(SpreadsheetApp.getActive(), DB.CLIENTS, id, {active: !!active});
  bustCache_();
  return adminLoad();
}
function adminAddMember(name, type, weeklyHours, email) {
  var ss = SpreadsheetApp.getActive();
  if (!String(name).trim()) return {ok: false, error: 'empty'};
  var wh = parseFloat(weeklyHours) || (type === 'full' ? DEFAULT_FT_HOURS : 0);
  addTeam_(ss, String(name).trim(), String(email || '').trim(), type || 'full', wh);
  bustCache_();
  return adminLoad();
}
function adminUpdateMember(id, patch) {
  update_(SpreadsheetApp.getActive(), DB.TEAM, id, patch);
  bustCache_();
  return adminLoad();
}
function adminSetAssignments(clientId, userIds) {
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(DB.ASSIGN);
    var data = sh.getDataRange().getValues();
    for (var r = data.length - 1; r >= 1; r--) {
      if (String(data[r][0]) === clientId) sh.deleteRow(r + 1);
    }
    if (userIds && userIds.length) {
      var add = userIds.map(function (u) { return [clientId, u]; });
      sh.getRange(sh.getLastRow() + 1, 1, add.length, 2).setValues(add);
    }
    bustCache_();
    return adminLoad();
  } finally { lock.releaseLock(); }
}

// ============================================================
//  SETTINGS + REMINDER EMAILS
// ============================================================
function adminSaveSettings(patch) {
  // Only allow known keys through.
  var allow = ['remindersEnabled','ccEmail','appBaseUrl','fridayHour','mondayHour','fromName'];
  var clean = {};
  allow.forEach(function (k) { if (patch.hasOwnProperty(k)) clean[k] = patch[k]; });
  var s = saveSettings_(clean);
  bustCache_();
  return {ok: true, settings: s};
}

/** Build a person's personal timesheet link from the configured base URL. */
function personLink_(base, slug) {
  if (!base) return '';
  return base + '/?user=' + encodeURIComponent(slug);
}

/** Shared: who is on the active roster, with email + slug. */
function activeTeamWithEmail_() {
  var ss = SpreadsheetApp.getActive();
  return rows_(ss, DB.TEAM)
    .filter(function (t) { return t.active !== false; })
    .map(function (t) { return {name: t.name, slug: t.slug, email: String(t.email || '').trim(), id: t.id}; });
}

/** FRIDAY: nudge everyone to fill in their hours, each linked to their own page. */
function sendFridayReminders() {
  var s = getSettings_();
  if (!s.remindersEnabled) return;
  if (!s.appBaseUrl) { Logger.log('No appBaseUrl set; skipping Friday reminders.'); return; }

  var week = fridayOf_(new Date());
  var team = activeTeamWithEmail_();
  team.forEach(function (p) {
    if (!p.email) return;   // no address, skip
    var link = personLink_(s.appBaseUrl, p.slug);
    MailApp.sendEmail({
      to: p.email,
      name: s.fromName,
      subject: s.fromName + ' — log your hours (week ending ' + week + ')',
      htmlBody:
        '<p>Hi ' + esc_(p.name) + ',</p>' +
        '<p>Please log your hours for the week ending <b>' + week + '</b>. You can enter time <b>day by day</b> and <b>Save draft</b> as you go — then hit <b>Submit week</b> once the week is done.</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#2f6f4f;color:#fff;' +
        'padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your timesheet</a></p>' +
        '<p style="color:#6b7580;font-size:13px">Or paste this link: ' + link + '</p>' +
        '<p style="color:#6b7580;font-size:13px">Missing a client, or need one removed from your list? Just message Aric.</p>'
    });
  });
}

/** MONDAY: chase anyone who has NOT submitted the just-ended week. CC the admin per email. */
function sendMondayChase() {
  var s = getSettings_();
  if (!s.remindersEnabled) return;
  if (!s.appBaseUrl) { Logger.log('No appBaseUrl set; skipping Monday chase.'); return; }

  var ss = SpreadsheetApp.getActive();
  // Chase for the week that JUST ENDED. On Monday, fridayOf_(today) returns THIS
  // week's upcoming Friday (which hasn't happened), so we step back one week.
  var week = previousFriday_(new Date());
  var status = adminSubmissionStatus(week);   // {rows:[{name,slug,submitted,at}]}
  var subBySlug = {};
  status.rows.forEach(function (r) { subBySlug[r.slug] = r.submitted; });

  var team = activeTeamWithEmail_();
  var overdue = team.filter(function (p) { return p.email && !subBySlug[p.slug]; });
  if (!overdue.length) return;

  overdue.forEach(function (p) {
    var link = personLink_(s.appBaseUrl, p.slug);
    var opts = {
      to: p.email,
      name: s.fromName,
      subject: '[Reminder] ' + s.fromName + ' — timesheet overdue (week ending ' + week + ')',
      htmlBody:
        '<p>Hi ' + esc_(p.name) + ',</p>' +
        '<p>Your timesheet for the week ending <b>' + week + '</b> hasn’t been submitted yet.</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#b06000;color:#fff;' +
        'padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Submit your hours now</a></p>' +
        '<p style="color:#6b7580;font-size:13px">Or paste this link: ' + link + '</p>'
    };
    if (s.ccEmail) opts.cc = s.ccEmail;
    MailApp.sendEmail(opts);
  });
}

/** Send a single test reminder to one person (or to the CC address) so you can preview it. */
function adminSendTest(slug) {
  var s = getSettings_();
  if (!s.appBaseUrl) return {ok: false, error: 'no_base_url'};
  var team = activeTeamWithEmail_();
  var p = team.filter(function (x) { return x.slug === slug; })[0];
  var to = (p && p.email) || s.ccEmail;
  if (!to) return {ok: false, error: 'no_recipient'};
  var link = personLink_(s.appBaseUrl, (p && p.slug) || 'aric');
  MailApp.sendEmail({
    to: to, name: s.fromName,
    subject: '[TEST] ' + s.fromName + ' timesheet reminder',
    htmlBody: '<p>This is a test of the timesheet reminder.</p>' +
      '<p><a href="' + link + '">' + link + '</a></p>' +
      '<p style="color:#6b7580;font-size:13px">If this looks right, your reminders are configured correctly.</p>'
  });
  return {ok: true, sentTo: to};
}

/** Send a welcome email with the person's personal link and a short how-to. */
function adminSendWelcome(slug) {
  var s = getSettings_();
  if (!s.appBaseUrl) return {ok: false, error: 'no_base_url'};
  var team = activeTeamWithEmail_();
  var p = team.filter(function (x) { return x.slug === slug; })[0];
  if (!p) return {ok: false, error: 'unknown_user'};
  if (!p.email) return {ok: false, error: 'no_email'};

  var link = personLink_(s.appBaseUrl, p.slug);
  var btn = 'display:inline-block;background:#2f6f4f;color:#fff;padding:11px 20px;' +
            'border-radius:8px;text-decoration:none;font-weight:600';
  MailApp.sendEmail({
    to: p.email,
    name: s.fromName,
    subject: 'Your Lockhern timesheet link',
    htmlBody:
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1f24;max-width:520px">' +
      '<p>Hi ' + esc_(p.name) + ',</p>' +
      '<p>You’re set up on our time tracker. Here’s your personal link — bookmark it, it’s just for you:</p>' +
      '<p><a href="' + link + '" style="' + btn + '">Open my timesheet →</a></p>' +
      '<p style="color:#6b7580;font-size:13px">Or paste this link: ' + link + '</p>' +
      '<p><b>How it works:</b></p>' +
      '<ul style="padding-left:18px;line-height:1.6">' +
        '<li>Log your <b>hours per client, day by day</b>. Use the <b>Today</b> view for a quick daily entry, or the <b>Week grid</b> to fill in the whole week at once. Round to the nearest half hour; it doesn’t need to be exact.</li>' +
        '<li>Hit <b>Save draft</b> whenever — your hours are kept and you can come back any day that week.</li>' +
        '<li>There’s an <b>Internal</b> line for Lockhern work that can’t be attributed to a client (ClickUp tasks, stand-ups, etc.), and an <b>Ad hoc support</b> line for when you step in on a client you don’t normally cover.</li>' +
        '<li>When the week is finished, hit <b>Submit week</b>. You can still edit and re-submit if something changes.</li>' +
        '<li>If one of your clients is missing, or one should be removed from your list, just <b>message Aric</b> — he’ll update it.</li>' +
      '</ul>' +
      '<p><b>When to do it:</b><br>Please submit your week by <b>end of day Friday</b>. You’ll get a reminder Friday, and a nudge Monday if it’s still open.</p>' +
      '<p>That’s it. Questions — just reply to this email.</p>' +
      '<p>Thanks,<br>' + esc_(s.fromName) + '</p>' +
      '</div>'
  });
  return {ok: true, sentTo: p.email};
}

/** Run ONCE from the editor to schedule the two reminders. Safe to re-run (clears first). */
function installReminderTriggers() {
  var s = getSettings_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendFridayReminders' || fn === 'sendMondayChase') ScriptApp.deleteTrigger(t);
  });
  var fHour = isNaN(s.fridayHour) ? 9 : s.fridayHour;
  var mHour = isNaN(s.mondayHour) ? 10 : s.mondayHour;
  ScriptApp.newTrigger('sendFridayReminders').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(fHour).create();
  ScriptApp.newTrigger('sendMondayChase').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(mHour).create();
  return 'Reminder triggers installed: Friday ' + fHour + ':00, Monday ' + mHour + ':00.';
}
function removeReminderTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendFridayReminders' || fn === 'sendMondayChase') ScriptApp.deleteTrigger(t);
  });
  return 'Reminder triggers removed.';
}
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

/** The calendar month ('yyyy-MM') an entry belongs to — by its actual DAY, so a
 *  week that straddles a month boundary lands each day in the right month.
 *  Legacy dateless rows fall back to the week-ending month. */
function entryMonth_(e) {
  var d = e.date ? weekStr_(e.date) : weekStr_(e.weekEnding);
  return d.substring(0, 7);
}

/** Work-weeks in a calendar month (business days ÷ 5), for month-scope capacity. */
function businessWeeksInMonth_(period) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return 4.33;
  var year = Number(m[1]), mon = Number(m[2]) - 1, bd = 0;
  var d = new Date(year, mon, 1);
  while (d.getMonth() === mon) {
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) bd++;
    d.setDate(d.getDate() + 1);
  }
  return Math.round((bd / 5) * 100) / 100;
}

function adminReport(period, scope, userId) {
  var ss = SpreadsheetApp.getActive();
  var team = rows_(ss, DB.TEAM);
  var clients = rows_(ss, DB.CLIENTS);
  var clientName = {internal: 'Internal', adhoc: 'Ad hoc support'};
  clients.forEach(function (c) { clientName[c.id] = c.name; });

  var entriesRaw = rows_(ss, DB.ENTRIES).filter(function (e) {
    if (String(e.clientId) === SUBMIT_MARKER) return false;
    // Month scope buckets by the entry's calendar DAY (no week-overlap); week scope by week-ending.
    var match = scope === 'month' ? entryMonth_(e) === period : weekStr_(e.weekEnding) === period;
    if (!match) return false;
    if (userId && userId !== 'all' && String(e.userId) !== String(userId)) return false;
    return true;
  });

  // Dedup by (user, week, client, DAY) — daily rows are summed; the latest wins per cell.
  var dedup = {};
  entriesRaw.forEach(function (e) {
    var day = e.date ? weekStr_(e.date) : '';
    var k = String(e.userId) + '|' + weekStr_(e.weekEnding) + '|' + String(e.clientId) + '|' + day;
    var at = String(e.updatedAt || '');
    if (!dedup[k] || at >= dedup[k].at) dedup[k] = {userId: String(e.userId), clientId: String(e.clientId), hours: Number(e.hours || 0), at: at};
  });
  var entries = Object.keys(dedup).map(function (k) { return dedup[k]; });

  var weekCount = scope === 'month' ? businessWeeksInMonth_(period) : 1;

  var byClient = {};
  entries.forEach(function (e) {
    var key = clientName[e.clientId] || e.clientId;
    byClient[key] = (byClient[key] || 0) + Number(e.hours || 0);
  });
  var byClientArr = Object.keys(byClient).map(function (k) { return {label: k, hours: round1_(byClient[k])}; })
    .sort(function (a, b) { return b.hours - a.hours; });

  var whoList = (userId && userId !== 'all')
    ? team.filter(function (t) { return t.id === userId; })
    : team.filter(function (t) { return t.active !== false; });
  var logged = {};
  entries.forEach(function (e) { logged[e.userId] = (logged[e.userId] || 0) + Number(e.hours || 0); });

  var capacity = whoList.map(function (t) {
    var avail = Number(t.weeklyHours || 0) * (scope === 'month' ? weekCount : 1);
    var used = round1_(logged[t.id] || 0);
    return {name: t.name, logged: used, available: round1_(avail),
            util: avail > 0 ? Math.round(used / avail * 100) : 0};
  });

  return {ok: true, scope: scope, period: period, weekCount: weekCount,
          byClient: byClientArr, capacity: capacity,
          totalHours: round1_(byClientArr.reduce(function (s, x) { return s + x.hours; }, 0))};
}

/**
 * Compact client x person hours matrix for a period. ONE sheet scan; the admin
 * page does all charting, filtering and drill-down from this in the browser.
 * Returns { clients:[{id,name}], people:[{id,name,type,weeklyHours}],
 *           matrix:{ clientId: { userId: hours } }, weekCount }.
 */
function adminMatrix(period, scope) {
  var ck = 'adminMatrix|' + period + '|' + scope;
  var hit = cacheGet_(ck); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  var res = matrixFromRows_(rows_(ss, DB.ENTRIES), rows_(ss, DB.TEAM), rows_(ss, DB.CLIENTS), period, scope);
  cachePut_(ck, res);
  return res;
}
function matrixFromRows_(entryRows, team, clientRows, period, scope) {
  var teamById = {};
  team.forEach(function (t) { teamById[String(t.id)] = t; });
  var clientName = {internal: 'Internal', adhoc: 'Ad hoc support', pto: 'PTO / time off'};
  clientRows.forEach(function (c) { clientName[String(c.id)] = c.name; });

  var raw = entryRows.filter(function (e) {
    if (String(e.clientId) === SUBMIT_MARKER) return false;
    // Month scope buckets by the entry's calendar DAY (no week-overlap); week scope by week-ending.
    return scope === 'month' ? entryMonth_(e) === period : weekStr_(e.weekEnding) === period;
  });

  // Dedup per (user, week, client, DAY); latest wins. Then sum into the matrix.
  var dedup = {};
  raw.forEach(function (e) {
    var day = e.date ? weekStr_(e.date) : '';
    var k = String(e.userId) + '|' + weekStr_(e.weekEnding) + '|' + String(e.clientId) + '|' + day;
    var at = String(e.updatedAt || '');
    if (!dedup[k] || at >= dedup[k].at) dedup[k] = {userId: String(e.userId), clientId: String(e.clientId), hours: Number(e.hours || 0), at: at};
  });

  var matrix = {};
  Object.keys(dedup).forEach(function (k) {
    var e = dedup[k];
    if (!matrix[e.clientId]) matrix[e.clientId] = {};
    matrix[e.clientId][e.userId] = round1_((matrix[e.clientId][e.userId] || 0) + e.hours);
  });
  var weekCount = scope === 'month' ? businessWeeksInMonth_(period) : 1;

  // People: active roster, plus any inactive person who logged time in the period.
  var people = team.filter(function (t) { return t.active !== false; })
    .map(function (t) { return {id: String(t.id), name: t.name, type: t.type, weeklyHours: Number(t.weeklyHours || 0)}; });
  var have = {};
  people.forEach(function (p) { have[p.id] = true; });
  Object.keys(matrix).forEach(function (cid) {
    Object.keys(matrix[cid]).forEach(function (uid) {
      if (!have[uid]) {
        have[uid] = true;
        var t = teamById[uid];
        people.push({id: uid, name: (t ? t.name : uid) + ' (inactive)', type: t ? t.type : '', weeklyHours: t ? Number(t.weeklyHours || 0) : 0});
      }
    });
  });

  var clients = Object.keys(matrix).map(function (cid) { return {id: cid, name: clientName[cid] || cid}; });

  return {ok: true, scope: scope, period: period, weekCount: weekCount,
          clients: clients, people: people, matrix: matrix};
}

function adminMonths() {
  var hit = cacheGet_('adminMonths'); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  var set = {};
  rows_(ss, DB.ENTRIES).forEach(function (e) {
    if (String(e.clientId) === SUBMIT_MARKER) return;
    var m = entryMonth_(e);   // calendar month of the day logged
    if (/^\d{4}-\d{2}$/.test(m)) set[m] = true;
  });
  var arr = Object.keys(set).sort().reverse();
  if (!arr.length) arr = [new Date().toISOString().substring(0, 7)];
  cachePut_('adminMonths', arr);
  return arr;
}

/** Submission status = the explicit submit marker per person for the week. */
function adminSubmissionStatus(week) {
  var ck = 'adminStatus|' + weekStr_(week);
  var hit = cacheGet_(ck); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  var team = rows_(ss, DB.TEAM).filter(function (t) { return t.active !== false; });
  var res = submissionStatusFromRows_(rows_(ss, DB.ENTRIES), team, week);
  cachePut_(ck, res);
  return res;
}
function submissionStatusFromRows_(entryRows, team, week) {
  var wk = weekStr_(week);
  var submittedAt = {};
  entryRows.forEach(function (e) {
    if (String(e.clientId) !== SUBMIT_MARKER) return;   // only explicit submissions count
    if (weekStr_(e.weekEnding) !== wk) return;
    var uid = String(e.userId), stamp = e.updatedAt;
    if (!submittedAt[uid] || String(stamp) > String(submittedAt[uid])) submittedAt[uid] = stamp;
  });
  return {
    ok: true, week: wk,
    rows: team.map(function (t) {
      return {name: t.name, slug: t.slug, submitted: !!submittedAt[t.id], at: submittedAt[t.id] || ''};
    })
  };
}

// ============================================================
//  ACCOUNT OWNERSHIP + REVENUE
//  A client has a monthly retainer, split across service channels (AI SEO, Paid
//  Search, Meta…). Each channel is owned by the person(s) who manage it — explicitly,
//  or, until set, the client's timesheet assignees. A channel's dollars are shared
//  evenly among its owners, which rolls up to "revenue managed" per person.
// ============================================================
function adminRevenue() {
  var hit = cacheGet_('adminRevenue'); if (hit) return hit;
  var ss = SpreadsheetApp.getActive();
  ensureRevenueTabs_(ss);

  var channelRows = rows_(ss, DB.CHANNELS);
  var channels = channelRows.filter(function (c) { return c.active !== false; })
    .map(function (c) { return {id: String(c.id), name: c.name}; });
  var teamAll = rows_(ss, DB.TEAM);
  var clientRows = rows_(ss, DB.CLIENTS);
  var assignments = rows_(ss, DB.ASSIGN).map(function (a) { return {clientId: String(a.clientId), userId: String(a.userId)}; });

  var revenue = {};
  rows_(ss, DB.REVENUE).forEach(function (r) {
    var c = String(r.clientId); if (!c) return;
    revenue[c] = {monthly: Number(r.monthly || 0), notes: String(r.notes || ''), splits: {}};
  });
  rows_(ss, DB.SPLIT).forEach(function (r) {
    var c = String(r.clientId); if (!c) return;
    if (!revenue[c]) revenue[c] = {monthly: 0, notes: '', splits: {}};
    revenue[c].splits[String(r.channelId)] = Number(r.amount || 0);
  });
  var owners = {};
  rows_(ss, DB.OWNERS).forEach(function (r) {
    var c = String(r.clientId), ch = String(r.channelId), u = String(r.userId);
    if (!c || !ch || !u) return;
    owners[c] = owners[c] || {};
    (owners[c][ch] = owners[c][ch] || []).push(u);
  });

  var model = revenueModel_(channels, clientRows, teamAll, assignments, revenue, owners);
  var activeClients = clientRows.filter(function (c) { return c.active !== false; })
    .map(function (c) { return {id: String(c.id), name: c.name}; })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var team = teamAll.filter(function (t) { return t.active !== false; })
    .map(function (t) { return {id: String(t.id), name: t.name, type: t.type}; });

  var res = {
    ok: true,
    channels: channels, clients: activeClients, team: team, assignments: assignments,
    revenue: revenue, owners: owners,
    byPerson: model.byPerson, byClient: model.byClient,
    unassigned: model.unassigned, totals: model.totals
  };
  cachePut_('adminRevenue', res);
  return res;
}

/**
 * Pure rollup (no sheet access): attributes each client's per-channel dollars to the
 * channel's owners (explicit, else the client's assignees), and sums per person.
 * Only ACTIVE clients count. Inactive people who still own revenue are listed too.
 */
function revenueModel_(channels, clientRows, teamAll, assignments, revenue, owners) {
  var chName = {}; channels.forEach(function (c) { chName[c.id] = c.name; });
  var clientName = {}, activeClient = {};
  clientRows.forEach(function (c) { var id = String(c.id); clientName[id] = c.name; activeClient[id] = (c.active !== false); });

  var assignees = {};
  assignments.forEach(function (a) { (assignees[a.clientId] = assignees[a.clientId] || []).push(a.userId); });

  var teamName = {}, activeId = {}, order = [];
  teamAll.forEach(function (t) {
    var id = String(t.id); teamName[id] = t.name;
    if (t.active !== false) { activeId[id] = true; order.push(id); }
  });

  function effOwners(cid, chid) {
    var o = owners[cid] && owners[cid][chid];
    if (o && o.length) return o.slice();                 // explicit owners
    return (assignees[cid] || []).slice();               // fall back to the client's assignees
  }

  var per = {};
  function bucket(uid) { return per[uid] || (per[uid] = {total: 0, clients: {}}); }

  var byClient = [], unassigned = 0;
  Object.keys(revenue).forEach(function (cid) {
    if (!activeClient[cid]) return;                      // only active clients are "managed"
    var r = revenue[cid], monthly = Number(r.monthly || 0), allocated = 0, splitsOut = {};
    channels.forEach(function (ch) {
      var amt = Number((r.splits || {})[ch.id] || 0);
      if (amt <= 0) return;
      allocated += amt; splitsOut[ch.id] = round1_(amt);
      var own = effOwners(cid, ch.id);
      if (!own.length) { unassigned += amt; return; }    // a funded channel nobody owns
      var share = amt / own.length;
      own.forEach(function (uid) {
        var b = bucket(uid); b.total += share;
        var pc = b.clients[cid] || (b.clients[cid] = {total: 0, channels: {}});
        pc.total += share; pc.channels[ch.id] = (pc.channels[ch.id] || 0) + share;
      });
    });
    byClient.push({clientId: cid, name: clientName[cid] || cid, monthly: round1_(monthly),
      allocated: round1_(allocated), unallocated: round1_(monthly - allocated), splits: splitsOut});
  });

  // People to list: active roster first, then any inactive person who still owns revenue.
  Object.keys(per).forEach(function (uid) { if (!activeId[uid] && order.indexOf(uid) < 0) order.push(uid); });

  var byPerson = order.map(function (uid) {
    var b = per[uid] || {total: 0, clients: {}};
    var clients = Object.keys(b.clients).map(function (cid) {
      return {
        clientId: cid, name: clientName[cid] || cid, total: round1_(b.clients[cid].total),
        channels: Object.keys(b.clients[cid].channels).map(function (chid) {
          return {channelId: chid, name: chName[chid] || chid, amount: round1_(b.clients[cid].channels[chid])};
        })
      };
    }).sort(function (a, b2) { return b2.total - a.total || String(a.name).localeCompare(String(b2.name)); });
    return {
      id: uid, name: (teamName[uid] || uid) + (activeId[uid] ? '' : ' (inactive)'),
      total: round1_(b.total), count: clients.length, clients: clients
    };
  }).sort(function (a, b2) { return b2.total - a.total || String(a.name).localeCompare(String(b2.name)); });

  byClient.sort(function (a, b2) { return b2.monthly - a.monthly || String(a.name).localeCompare(String(b2.name)); });
  var gMonthly = byClient.reduce(function (s, x) { return s + x.monthly; }, 0);
  var gAllocated = byClient.reduce(function (s, x) { return s + x.allocated; }, 0);
  return {
    byPerson: byPerson, byClient: byClient, unassigned: round1_(unassigned),
    totals: {monthly: round1_(gMonthly), allocated: round1_(gAllocated), attributed: round1_(gAllocated - unassigned)}
  };
}

/** Save the channel list. list = [{id?, name, active}]; removed channels are kept inactive
 *  so existing splits/owners aren't orphaned. */
function adminSaveChannels(list) {
  var ss = SpreadsheetApp.getActive();
  ensureRevenueTabs_(ss);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var existing = rows_(ss, DB.CHANNELS);
    var seen = {}, out = [['id', 'name', 'active']];
    (list || []).forEach(function (c) {
      var name = String(c.name || '').trim(); if (!name) return;
      var id = c.id ? String(c.id) : Utilities.getUuid();
      seen[id] = true;
      out.push([id, name, c.active === false ? false : true]);
    });
    existing.forEach(function (e) { if (!seen[String(e.id)]) out.push([String(e.id), e.name, false]); });
    var sh = ss.getSheetByName(DB.CHANNELS);
    sh.clearContents();
    sh.getRange(1, 1, out.length, 3).setValues(out);
    bustCache_();
    return adminRevenue();
  } finally { lock.releaseLock(); }
}

/** Save a client's retainer + per-channel split. splits = { channelId: dollars }. */
function adminSaveClientRevenue(clientId, monthly, notes, splits) {
  var ss = SpreadsheetApp.getActive();
  ensureRevenueTabs_(ss);
  clientId = String(clientId || '');
  if (!clientId) return {ok: false, error: 'no_client'};
  var m = Number(monthly); if (isNaN(m) || m < 0) m = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rsh = ss.getSheetByName(DB.REVENUE), rdata = rsh.getDataRange().getValues(), found = false;
    for (var r = 1; r < rdata.length; r++) {
      if (String(rdata[r][0]) === clientId) { rsh.getRange(r + 1, 2).setValue(m); rsh.getRange(r + 1, 3).setValue(String(notes || '')); found = true; break; }
    }
    if (!found) rsh.appendRow([clientId, m, String(notes || '')]);

    var ssh = ss.getSheetByName(DB.SPLIT), sdata = ssh.getDataRange().getValues();
    var keep = [sdata[0] || ['clientId', 'channelId', 'amount']];
    for (var i = 1; i < sdata.length; i++) { if (String(sdata[i][0]) !== clientId) keep.push(sdata[i]); }
    Object.keys(splits || {}).forEach(function (chid) {
      var amt = Number(splits[chid]); if (!isNaN(amt) && amt > 0) keep.push([clientId, String(chid), amt]);
    });
    ssh.clearContents();
    ssh.getRange(1, 1, keep.length, 3).setValues(keep);
    bustCache_();
    return adminRevenue();
  } finally { lock.releaseLock(); }
}

/** Set the explicit owners of one client-channel. Empty list ⇒ reverts to the client's assignees. */
function adminSaveChannelOwners(clientId, channelId, userIds) {
  var ss = SpreadsheetApp.getActive();
  ensureRevenueTabs_(ss);
  clientId = String(clientId || ''); channelId = String(channelId || '');
  if (!clientId || !channelId) return {ok: false, error: 'bad_args'};
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(DB.OWNERS), data = sh.getDataRange().getValues();
    var keep = [data[0] || ['clientId', 'channelId', 'userId']];
    for (var i = 1; i < data.length; i++) {
      if (!(String(data[i][0]) === clientId && String(data[i][1]) === channelId)) keep.push(data[i]);
    }
    (userIds || []).forEach(function (u) { u = String(u); if (u) keep.push([clientId, channelId, u]); });
    sh.clearContents();
    sh.getRange(1, 1, keep.length, 3).setValues(keep);
    bustCache_();
    return adminRevenue();
  } finally { lock.releaseLock(); }
}

// ============================================================
//  DB HELPERS  (unchanged from the working app)
// ============================================================
function rows_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var header = data[0];
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var o = {};
    for (var c = 0; c < header.length; c++) {
      var key = header[c], v = data[r][c];
      if (key === 'active') v = (v === '' ? true : (v === true || v === 'TRUE' || v === 'true'));
      o[key] = v;
    }
    o.id = String(o.id);
    out.push(o);
  }
  return out;
}
function update_(ss, name, id, patch) {
  var sh = ss.getSheetByName(name);
  var data = sh.getDataRange().getValues();
  var header = data[0];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(id)) {
      Object.keys(patch).forEach(function (k) {
        var col = header.indexOf(k);
        if (col >= 0) sh.getRange(r + 1, col + 1).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}
function addClient_(ss, name) { ss.getSheetByName(DB.CLIENTS).appendRow([Utilities.getUuid(), name, true]); }
function addTeam_(ss, name, email, type, weeklyHours) {
  var sh = ss.getSheetByName(DB.TEAM);
  var slug = slugify_(name);
  var existing = rows_(ss, DB.TEAM).map(function (t) { return t.slug; });
  var base = slug, i = 2;
  while (existing.indexOf(slug) >= 0) { slug = base + '_' + i; i++; }
  sh.appendRow([Utilities.getUuid(), name, slug, email || '', type || 'full', weeklyHours || DEFAULT_FT_HOURS, true]);
}
function teamBySlug_(ss, slug) {
  var t = rows_(ss, DB.TEAM).filter(function (x) { return x.slug === slug && x.active !== false; });
  return t[0] || null;
}
function assignmentsFor_(ss, userId) {
  var map = {};
  rows_(ss, DB.ASSIGN).forEach(function (a) {
    if (String(a.userId) === String(userId)) map[String(a.clientId)] = true;
  });
  return map;
}

/** Per-week daily hours for one user: { clientId: { 'yyyy-mm-dd': hours } }.
 *  Legacy dateless rows are surfaced under the week's Friday date. */
function entriesFor_(ss, userId, week) {
  return entriesForRows_(rows_(ss, DB.ENTRIES), userId, week);
}
function entriesForRows_(entryRows, userId, week) {
  var uid = String(userId), wk = weekStr_(week);
  var acc = {};   // clientId -> { date -> {hours, at} }
  entryRows.forEach(function (e) {
    if (String(e.clientId) === SUBMIT_MARKER) return;
    if (String(e.userId) !== uid || weekStr_(e.weekEnding) !== wk) return;
    var cid = String(e.clientId);
    var d = e.date ? weekStr_(e.date) : wk;
    var at = String(e.updatedAt || '');
    acc[cid] = acc[cid] || {};
    if (!acc[cid][d] || at >= acc[cid][d].at) acc[cid][d] = {hours: Number(e.hours || 0), at: at};
  });
  var out = {};
  Object.keys(acc).forEach(function (cid) {
    out[cid] = {};
    Object.keys(acc[cid]).forEach(function (d) { out[cid][d] = acc[cid][d].hours; });
  });
  return out;
}

// ============================================================
//  UTIL
// ============================================================
function slugify_(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function fridayOf_(d) {
  var x = new Date(d.getTime());
  var dow = x.getDay();
  x.setDate(x.getDate() + (dow === 6 ? -1 : 5 - dow));
  return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
/** The most recent Friday that has ALREADY passed (or today if today is Friday).
 *  On Mon-Thu this returns last week's Friday; on Fri/Sat it returns this week's. */
function previousFriday_(d) {
  var x = new Date(d.getTime());
  var dow = x.getDay();           // 0 Sun .. 6 Sat
  var back = (dow - 5 + 7) % 7;   // days since the most recent Friday
  x.setDate(x.getDate() - back);
  return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function recentFridays_(n) {
  var out = [], d = new Date();
  var dow = d.getDay();
  d.setDate(d.getDate() + (dow === 6 ? -1 : 5 - dow));
  for (var i = 0; i < n; i++) {
    out.push(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    d.setDate(d.getDate() - 7);
  }
  return out;
}
function round1_(n) { return Math.round(Number(n) * 10) / 10; }
function weekStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return s;
}
