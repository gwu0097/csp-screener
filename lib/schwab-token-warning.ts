// Single source of truth for "should the Schwab reconnect warning show,
// and what should it say." Every consumer (dashboard banner, screener
// badge, token-status route) calls evaluateSchwabTokenWarning() instead
// of re-deriving its own days-remaining threshold — previously five
// different call sites had five different thresholds, one of them
// (schwab-status-banner.tsx) computing "today" from the browser's own
// clock/timezone instead of a fixed reference.
//
// The goal state this encodes: Schwab refresh tokens live 7 days, and
// reconnecting on a weekend keeps the 7-day cycle landing on a weekend
// forever after (Sat + 7d = Sat). Reconnecting on a weekday breaks that
// cycle and means every future expiry lands on a weekday too, each one
// silently interrupting a trading day, until a weekend reconnect resets
// it. The clauses below are not day-count tiers — they're the specific
// situations that call for a nudge under that model.
//
// Clause 1 was retired and folded into clause 2: it used to be a
// separate "expiry falls on a weekend" check with its own anchor-date
// formula, while clause 2 fired unconditionally, every single day, the
// instant an expiry fell on a weekday — even when a full weekend still
// stood between today and expiry. Clause 2 is now "warn starting at the
// last Saturday on/before the expiry date," computed generically for
// any expiry weekday; a weekend expiry's anchor is trivially itself (or
// the day before, for Sunday), so the old clause 1 case falls out of
// the same formula and needed no separate code path.
//
// ALL date math is anchored to America/Los_Angeles regardless of where
// this runs (Vercel's server clock is UTC; a browser's clock is
// whatever the visitor's OS is set to) — every comparison below reads
// "today" and "the expiry date" as LA calendar dates, not raw UTC
// instants.

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// YYYY-MM-DD for the LA calendar date `d` falls on.
function laDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// A short human label for `d`'s LA calendar date, e.g. "Aug 16 (Sat)".
function laDateLabel(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  }).format(d);
  return `${parts} (${DAY_NAMES[weekdayOf(laDateString(d))].slice(0, 3)})`;
}

// 0=Sun..6=Sat for a YYYY-MM-DD string. Anchored to UTC midnight
// deliberately — the string already IS the LA calendar date, so
// re-running it through any timezone conversion here would risk a
// DST-boundary off-by-one. This is pure calendar-date arithmetic from
// this point on, no more timezone involved.
function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A short label for a plain YYYY-MM-DD calendar-date string, e.g.
// "Aug 15 (Sat)". Deliberately does NOT go through laDateLabel/Intl
// timezone conversion — dateStr is already an LA calendar date with no
// associated instant, and formatting it via a UTC-midnight Date through
// an LA-timezone Intl formatter would shift it back a day.
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function dateStringLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${d} (${DAY_NAMES[weekdayOf(dateStr)].slice(0, 3)})`;
}

export type SchwabTokenWarningClause = 2 | 3 | 4;

export type SchwabTokenWarning = {
  shouldWarn: boolean;
  // Which clause fired — null when none did. If multiple clauses would
  // independently justify a warning, the most specific/urgent one wins
  // (4 checked first and unsuppressible, then 2, then 3) rather than
  // reporting all of them; there's one message to show, not a list.
  clause: SchwabTokenWarningClause | null;
  message: string;
};

export function evaluateSchwabTokenWarning({
  expiresAt,
  lastRefreshedAt,
  now = new Date(),
}: {
  // refresh_token_expires_at — a full reconnect is what clears this.
  expiresAt: Date | string | null;
  // schwab_tokens.updated_at — when the current token was issued.
  // Only used for clause 3's 24h suppression.
  lastRefreshedAt: Date | string | null;
  now?: Date;
}): SchwabTokenWarning {
  const none: SchwabTokenWarning = { shouldWarn: false, clause: null, message: "" };
  if (!expiresAt) return none;
  const expiresAtDate = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(expiresAtDate.getTime())) return none;

  const expiryLabel = laDateLabel(expiresAtDate);

  // Clause 4 — unconditional, checked first, never suppressed by
  // anything below. Already expired, or expiring within 24 real hours
  // (a raw instant-to-instant comparison, not a calendar-date one —
  // "within 24 hours" means exactly that, regardless of what day it
  // technically rolls over into).
  const hoursUntilExpiry = (expiresAtDate.getTime() - now.getTime()) / 3_600_000;
  if (hoursUntilExpiry <= 24) {
    const expired = hoursUntilExpiry <= 0;
    return {
      shouldWarn: true,
      clause: 4,
      message: expired
        ? `Schwab token expired ${expiryLabel} — reconnect now.`
        : `Schwab token expires within 24 hours, ${expiryLabel} — reconnect now.`,
    };
  }

  const todayStr = laDateString(now);
  const expiryStr = laDateString(expiresAtDate);
  const expiryWeekday = weekdayOf(expiryStr); // 0=Sun..6=Sat

  // Clause 2 — warn starting at the last Saturday on/before the expiry
  // date, for ANY expiry weekday. A Saturday expiry anchors to itself
  // (0 days back); a Sunday expiry anchors to the day before; a weekday
  // expiry anchors to the most recent Saturday before it — e.g. a
  // Wednesday expiry anchors 4 days back. Formula: (expiryWeekday+1)%7
  // days back from expiryStr always lands on the preceding (or same)
  // Saturday. Not suppressible.
  const daysBackToAnchorSaturday = (expiryWeekday + 1) % 7;
  const anchorSaturdayStr = addDaysToDateString(expiryStr, -daysBackToAnchorSaturday);
  if (todayStr >= anchorSaturdayStr) {
    const anchorSundayStr = addDaysToDateString(anchorSaturdayStr, 1);
    // Still within the qualifying weekend itself → "reconnect this
    // weekend" is accurate. Once today has moved past that weekend
    // (e.g. a Wednesday expiry whose anchor Saturday came and went),
    // there is no weekend left before expiry — say so instead of
    // pointing at a weekend that's already gone.
    const withinAnchorWeekend = todayStr <= anchorSundayStr;
    return {
      shouldWarn: true,
      clause: 2,
      message: withinAnchorWeekend
        ? `Schwab token expires ${expiryLabel} — reconnect this weekend to keep the expiry landing on a weekend.`
        : `Schwab token expires ${expiryLabel} — the weekend to reconnect without desyncing (${dateStringLabel(anchorSaturdayStr)}–${dateStringLabel(anchorSundayStr)}) has passed. Reconnect now.`,
    };
  }

  // Clause 3 — today is a weekend, and the current token won't survive
  // to the NEXT weekend (i.e. this is the last weekend opportunity to
  // reconnect before a weekday reconnect becomes the only option).
  // Suppressed only when the token was refreshed within the last 24
  // hours, so reconnecting Saturday doesn't also warn on Sunday.
  const todayWeekday = weekdayOf(todayStr);
  const isTodayWeekend = todayWeekday === 0 || todayWeekday === 6;
  if (isTodayWeekend) {
    const daysToNextWeekendSaturday = todayWeekday === 6 ? 7 : 6;
    const nextWeekendSaturdayStr = addDaysToDateString(todayStr, daysToNextWeekendSaturday);
    const dueWithinLifetime = expiryStr <= nextWeekendSaturdayStr;
    const refreshedRecently =
      lastRefreshedAt != null &&
      now.getTime() -
        (typeof lastRefreshedAt === "string" ? new Date(lastRefreshedAt) : lastRefreshedAt).getTime() <
        24 * 3_600_000;
    if (dueWithinLifetime && !refreshedRecently) {
      return {
        shouldWarn: true,
        clause: 3,
        message: `It's the weekend — reconnect Schwab now while you can, to keep the token's expiry (currently ${expiryLabel}) aligned to a weekend.`,
      };
    }
  }

  return none;
}
