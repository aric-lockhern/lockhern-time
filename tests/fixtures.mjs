// A small but varied Sheet: full-time + freelancer + one inactive person who logged time,
// active + inactive clients, daily entries across a month boundary (week ending 2026-10-02 spans
// Sep 28 - Oct 2), explicit submit markers, and one legacy dateless row. "Today" is 2026-10-09.
export const SECRET = 'x'.repeat(40);        // >= 24 chars
export const ADMIN_PASSWORD = 'founders';
export const BASE = 'https://timetracking.lockherndigital.com';

// Weeks (recentFridays_(12) from 2026-10-09): used by name below.
export const W_THIS = '2026-10-09';          // statusWeek / defaultWeek
export const W_PREV = '2026-10-02';          // adminLoad defaultPeriod (weeks[1]); spans Sep/Oct
export const W_OLD = '2026-09-25';

export function tabs() {
  return {
    Team: [
      ['id', 'name', 'slug', 'email', 'type', 'weeklyHours', 'active'],
      ['u1', 'Aric', 'aric', 'aric@lockherndigital.com', 'full', 40, true],
      ['u2', 'Bea', 'bea', 'bea@lockherndigital.com', 'full', 40, true],
      ['u3', 'Cy', 'cy', '', 'free', 20, true],
      ['u4', 'Dalia', 'dalia', 'dalia@old.com', 'full', 40, false],   // inactive, but logged time in W_PREV
    ],
    Clients: [
      ['id', 'name', 'active'],
      ['c1', 'Acme', true],
      ['c2', 'Beta Co', true],
      ['c3', 'Zeta', false],   // inactive client
    ],
    Assignments: [
      ['clientId', 'userId'],
      ['c1', 'u1'],
      ['c1', 'u2'],
      ['c2', 'u2'],
      ['c2', 'u3'],
    ],
    Entries: [
      ['id', 'userId', 'weekEnding', 'clientId', 'hours', 'updatedAt', 'date'],
      // Week ending 2026-10-02 (Mon 09-28 .. Fri 10-02) — straddles the Sep/Oct boundary.
      ['e1', 'u1', W_PREV, 'c1', 5, '2026-10-02 09:00', '2026-09-28'],
      ['e2', 'u1', W_PREV, 'c1', 3, '2026-10-02 09:05', '2026-10-01'],
      ['e3', 'u1', W_PREV, 'c2', 2, '2026-10-02 09:06', '2026-10-02'],
      ['e4', 'u2', W_PREV, 'c1', 8, '2026-10-02 10:00', '2026-09-29'],
      ['e5', 'u2', W_PREV, 'internal', 4, '2026-10-02 10:01', '2026-10-01'],
      ['e6', 'u3', W_PREV, 'c2', 6, '2026-10-02 11:00', '2026-10-02'],
      ['e7', 'u4', W_PREV, 'c1', 7, '2026-10-02 08:00', '2026-09-30'],   // inactive user
      ['sm1', 'u1', W_PREV, '__submitted__', 1, '2026-10-02 12:00', ''],
      ['sm2', 'u2', W_PREV, '__submitted__', 1, '2026-10-02 12:30', ''],
      // Week ending 2026-10-09 — PTO + a client, submitted by u1 only.
      ['e8', 'u1', W_THIS, 'c1', 4, '2026-10-09 09:00', '2026-10-05'],
      ['e9', 'u1', W_THIS, 'pto', 8, '2026-10-09 09:01', '2026-10-06'],
      ['sm3', 'u1', W_THIS, '__submitted__', 1, '2026-10-09 12:00', ''],
      // Legacy dateless row (date == '') — surfaced under its week's Friday.
      ['e10', 'u3', W_OLD, 'c2', 10, '2026-09-25 09:00', ''],
    ],
    Settings: [
      ['key', 'value'],
      ['remindersEnabled', 'yes'],
      ['ccEmail', 'aric@lockherndigital.com'],
      ['appBaseUrl', BASE],
      ['fridayHour', '9'],
      ['mondayHour', '10'],
      ['fromName', 'Lockhern Digital'],
    ],
    // Account ownership + revenue. c1 pays 10k split 2k/5k/3k; Paid Search → Aric, Meta → Bea,
    // AI SEO has no explicit owner (falls back to c1's assignees u1+u2). c2 pays 6k all Paid
    // Search, no explicit owner (falls back to c2's assignees u2+u3).
    Channels: [
      ['id', 'name', 'active'],
      ['ch_seo', 'AI SEO', true],
      ['ch_ps', 'Paid Search', true],
      ['ch_meta', 'Meta', true],
    ],
    Revenue: [
      ['clientId', 'monthly', 'notes'],
      ['c1', 10000, ''],
      ['c2', 6000, ''],
    ],
    RevenueSplit: [
      ['clientId', 'channelId', 'amount'],
      ['c1', 'ch_seo', 2000],
      ['c1', 'ch_ps', 5000],
      ['c1', 'ch_meta', 3000],
      ['c2', 'ch_ps', 6000],
    ],
    ChannelOwners: [
      ['clientId', 'channelId', 'userId'],
      ['c1', 'ch_ps', 'u1'],
      ['c1', 'ch_meta', 'u2'],
    ],
  };
}
