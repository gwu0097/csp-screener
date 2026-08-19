// NYSE market holiday calendar — computed per year, not a hardcoded
// date list, so it stays correct indefinitely rather than silently
// going stale past whatever year someone last updated a table. Used
// only where a real closure needs to be distinguished from an ordinary
// weekend (e.g. deciding whether a calendar Friday is actually a
// listed option expiry) — most of this codebase's date math is
// deliberately weekend-only (see lib/positions.ts's own comment on
// this), and this module exists specifically for the few call sites
// that need the stronger guarantee.
//
// Every date in/out is a YYYY-MM-DD string, UTC-midnight, matching the
// rest of the codebase's date convention.

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Nth weekday-of-month (n=1..5), 0=Sunday..6=Saturday, both UTC.
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day));
}

// Last weekday-of-month (e.g. last Monday of May for Memorial Day).
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const lastWeekday = lastDay.getUTCDay();
  const back = (lastWeekday - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, lastDay.getUTCDate() - back));
}

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — Easter Sunday
// for a given year, UTC.
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// Federal/NYSE weekend-observation rule: Saturday -> observed Friday
// before; Sunday -> observed Monday after. Applied only to the
// fixed-date holidays below — the weekday-rule holidays (MLK,
// Presidents, Memorial, Labor, Thanksgiving) and Good Friday are never
// on a weekend by construction.
function observed(d: Date): Date {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() - 24 * 60 * 60 * 1000);
  if (day === 0) return new Date(d.getTime() + 24 * 60 * 60 * 1000);
  return d;
}

function nyseHolidaysForYear(year: number): Set<string> {
  const dates: Date[] = [
    observed(new Date(Date.UTC(year, 0, 1))), // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Day — 3rd Monday of January
    nthWeekdayOfMonth(year, 1, 1, 3), // Washington's Birthday — 3rd Monday of February
    new Date(easterSunday(year).getTime() - 2 * 24 * 60 * 60 * 1000), // Good Friday
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day — last Monday of May
    observed(new Date(Date.UTC(year, 5, 19))), // Juneteenth (NYSE observed from 2022)
    observed(new Date(Date.UTC(year, 6, 4))), // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day — 1st Monday of September
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving — 4th Thursday of November
    observed(new Date(Date.UTC(year, 11, 25))), // Christmas Day
  ];
  return new Set(dates.map(toIso));
}

const yearCache = new Map<number, Set<string>>();
function holidaysForYear(year: number): Set<string> {
  let s = yearCache.get(year);
  if (!s) {
    s = nyseHolidaysForYear(year);
    yearCache.set(year, s);
  }
  return s;
}

export function isNyseHoliday(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  return holidaysForYear(year).has(iso);
}

// Walks backward from iso to the nearest date that's neither a weekend
// nor an NYSE holiday. Used for the OCC's own holiday-shift rule: when
// a listed expiry would fall on an exchange closure, it expires the
// preceding business day instead (Good Friday is the recurring case —
// NYSE and the options market are both closed).
export function precedingTradingDay(iso: string): string {
  let d = new Date(iso + "T00:00:00Z");
  for (;;) {
    d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
    const day = d.getUTCDay();
    const s = toIso(d);
    if (day !== 0 && day !== 6 && !isNyseHoliday(s)) return s;
  }
}
