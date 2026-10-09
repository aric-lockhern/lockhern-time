// Loads the real apps-script/Code.gs + Publish.gs into one VM context with in-memory stubs for the
// Apps Script services they use, so tests drive the SAME code that runs in Google Apps Script.
// The spreadsheet, Script Properties, cache and UrlFetchApp are all backed by plain objects the
// test controls. "Today" is pinned to 2026-10-09 (a Friday) so the week math is deterministic.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const PUBLISH = fs.readFileSync(path.join(ROOT, 'apps-script', 'Publish.gs'), 'utf8');

export const FIXED_NOW = Date.UTC(2026, 9, 9, 16, 0, 0);   // 2026-10-09, noon US/Eastern-ish

// ---- in-memory spreadsheet ----
class Range {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sh.d[this.r - 1 + i] || [];
      const o = [];
      for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
      out.push(o);
    }
    return out;
  }
  setValues(vals) {
    for (let i = 0; i < vals.length; i++) {
      const ri = this.r - 1 + i;
      if (!this.sh.d[ri]) this.sh.d[ri] = [];
      for (let j = 0; j < vals[i].length; j++) this.sh.d[ri][this.c - 1 + j] = vals[i][j];
    }
    return this;
  }
  setValue(v) {
    const ri = this.r - 1;
    if (!this.sh.d[ri]) this.sh.d[ri] = [];
    this.sh.d[ri][this.c - 1] = v;
    return this;
  }
  setFontWeight() { return this; }
}
class Sheet {
  constructor(name, data) { this.name = name; this.d = data; }
  getName() { return this.name; }
  getLastRow() { return this.d.length; }
  getLastColumn() { return this.d.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { return new Range(this, 1, 1, this.d.length, this.getLastColumn() || 1); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
  appendRow(row) { this.d.push(row.slice()); }
  clearContents() { this.d = []; }
  deleteRow(r) { this.d.splice(r - 1, 1); }
}
export function spreadsheet(tabs) {
  const sheets = {};
  Object.keys(tabs).forEach((name) => { sheets[name] = new Sheet(name, tabs[name].map((r) => r.slice())); });
  return {
    sheets,
    getSheetByName(n) { return sheets[n] || null; },
    insertSheet(n) { const s = new Sheet(n, []); sheets[n] = s; return s; },
    getSpreadsheetTimeZone() { return 'America/New_York'; },
  };
}

// ---- Apps Script service stubs, closing over `state` ----
function makeSandbox(state) {
  const cache = state.cache || (state.cache = new Map());
  const props = state.props || (state.props = {});

  function formatDate(d, tz, fmt) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const m = {}; parts.forEach((p) => { m[p.type] = p.value; });
    const hh = m.hour === '24' ? '00' : m.hour;
    return String(fmt).replace('yyyy', m.year).replace('MM', m.month).replace('dd', m.day).replace('HH', hh).replace('mm', m.minute);
  }

  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(FIXED_NOW); else super(...a); }
    static now() { return FIXED_NOW; }
  }

  const sandbox = {
    console, JSON, Math, Object, Array, String, Number, Boolean, isNaN, parseInt, parseFloat, RegExp, Error,
    Date: FakeDate,
    SpreadsheetApp: {
      getActive() { return state.ss; },
      getUi() { throw new Error('no UI in tests'); },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty(k, v) { props[k] = String(v); return this; },
          deleteProperty(k) { delete props[k]; return this; },
        };
      },
    },
    CacheService: {
      getScriptCache() {
        return {
          get(k) { return cache.has(k) ? cache.get(k) : null; },
          put(k, v) { cache.set(k, String(v)); },
          remove(k) { cache.delete(k); },
        };
      },
    },
    LockService: {
      getScriptLock() { return { waitLock() {}, tryLock() { return true; }, releaseLock() {} }; },
    },
    Session: { getScriptTimeZone() { return 'America/New_York'; } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      formatDate,
      getUuid() { return crypto.randomUUID(); },
      newBlob(s) { const bytes = Array.from(Buffer.from(String(s), 'utf8')); return { getBytes() { return bytes; }, _s: String(s) }; },
      // No-op "gzip": keep the raw bytes; the UrlFetchApp bridge re-gzips for real on the way to the function.
      gzip(blob) { return { getBytes() { return blob.getBytes(); } }; },
      base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
      computeDigest(_alg, s) { return Array.from(crypto.createHash('sha256').update(String(s)).digest()); },
    },
    UrlFetchApp: {
      fetch(url, opt) { return state.fetch(url, opt); },
    },
    ScriptApp: {
      getProjectTriggers() { return []; },
      newTrigger() { throw new Error('triggers not exercised in tests'); },
    },
    MailApp: { sendEmail() {} },
    Logger: { log() {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _s: s, setMimeType() { return this; }, getContent() { return this._s; } }; },
    },
    HtmlService: { createHtmlOutput() { return { setWidth() { return this; }, setHeight() { return this; } }; } },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

export function loadApp(state) {
  const sandbox = makeSandbox(state);
  vm.createContext(sandbox);
  vm.runInContext(CODE + '\n;\n' + PUBLISH, sandbox, { filename: 'apps-script.gs' });
  return sandbox;
}
