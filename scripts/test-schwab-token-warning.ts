// Scratch validation for lib/schwab-token-warning.ts — not a test
// suite, just a battery of concrete date scenarios to sanity-check the
// clause logic before wiring it into the app.
import { evaluateSchwabTokenWarning } from "../lib/schwab-token-warning";

function la(dateStr: string, hour = 12): Date {
  // Construct an instant that falls on `dateStr` in LA time at `hour`.
  // LA is UTC-7 (PDT) in August — using a fixed offset here on purpose
  // since this script only needs to exercise summer dates.
  return new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00-07:00`);
}

function run(label: string, now: Date, expiresAt: Date, lastRefreshedAt: Date | null) {
  const r = evaluateSchwabTokenWarning({ expiresAt, lastRefreshedAt, now });
  console.log(`${label}\n  shouldWarn=${r.shouldWarn} clause=${r.clause}\n  ${r.message || "(no message)"}\n`);
}

// Healthy weekend cycle: refreshed Sat Aug 15, expires Sat Aug 22 (7d).
const refreshedSat = la("2026-08-15", 10);
const expiresNextSat = la("2026-08-22", 10);

run("Same Saturday, minutes after refresh", la("2026-08-15", 10, ), expiresNextSat, refreshedSat);
run("Sunday, 26h after Saturday refresh (should fire clause 3)", la("2026-08-16", 12), expiresNextSat, refreshedSat);
run("Sunday, 4h after refresh (should be suppressed)", la("2026-08-16", 14), la("2026-08-16", 14 + 24*6), refreshedSat);
run("Tuesday mid-cycle (should be silent)", la("2026-08-18", 12), expiresNextSat, refreshedSat);
run("Friday before expiry weekend (should be silent — anchor is Saturday)", la("2026-08-21", 10), expiresNextSat, refreshedSat);
run("The expiry Saturday itself (clause 1)", la("2026-08-22", 8), expiresNextSat, refreshedSat);
run("Sunday of expiry weekend, after Saturday's expiry passed (clause 4, expired)", la("2026-08-23", 8), expiresNextSat, refreshedSat);

// Desynced: expires Wed Aug 19 (a weekday).
const expiresWed = la("2026-08-19", 10);
run("Monday, desynced weekday expiry (clause 2)", la("2026-08-17", 9), expiresWed, la("2026-08-12", 9));
run("Saturday BEFORE a desynced weekday expiry (clause 2 should still win over any clause-3 same-day check)", la("2026-08-15", 9), expiresWed, la("2026-08-12", 9));

// Within 24h, on a weekend expiry — clause 4 must win over clause 1.
run("Friday evening, expiry is Saturday ~18h away (clause 4 must override clause 1)", la("2026-08-21", 16), la("2026-08-22", 10), refreshedSat);

// Already expired.
run("Already expired 3 days ago (clause 4)", la("2026-08-20", 12), la("2026-08-17", 10), la("2026-08-10", 10));

// Sunday expiry (late in the day), checked the preceding Saturday
// morning — >24h before expiry, so this should distinctly exercise
// clause 1 rather than clause 4 winning by proximity.
const expiresSunEvening = la("2026-08-23", 20); // Sun Aug 23, 8pm
run("Saturday morning, expiry is Sunday evening (~34h out — clause 1, not 4)", la("2026-08-22", 10), expiresSunEvening, la("2026-08-15", 10));
run("Thursday, several days before a healthy weekend expiry (should be silent)", la("2026-08-20", 10), expiresNextSat, refreshedSat);
