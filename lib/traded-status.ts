// "Already traded" status for screener rows. Pure — no I/O — so the
// matching rules are unit-testable (lib/traded-status.test.ts). The
// /api/screener/traded route feeds it the user's short-put positions,
// their campaigns' earnings dates, and the user's manual marks.
//
// A position counts toward an event (symbol + earnings_date) when:
//   1. its campaign is keyed on that event (lib/campaigns.ts already
//      resolved it — this also covers rolls opened after the print), or
//   2. it has no campaign yet and its hold window spans the print
//      (opened on or before earnings_date, expiring on or after it) —
//      the same range rule campaigns use, for fills the campaign pass
//      hasn't reached.
// Only short put options count: stock legs (position_type stock_long /
// stock_short, which store strike 0) and covered calls are not "traded
// this print" for a CSP screener.
//
// Capital is the cash securing the still-open contracts: strike × 100 ×
// open contracts (opened minus closed fills, lib/positions
// remainingContracts). Closed or expired legs still mark the event as
// traded but hold no capital. A leg still marked "open" after its expiry
// (the sync hasn't recorded the expiry/assignment yet) is not counted as
// open: it's reported separately as stale so the cell can say so,
// rather than inflating the capital figure.

export type TradedPositionRow = {
  symbol: string;
  status: string | null;
  // Opened minus closed contracts from fills; null when the position's
  // fills weren't loaded (capital is then unknown, never 0).
  open_contracts: number | null;
  broker: string | null;
  strike: number | string | null;
  expiry: string;
  opened_date: string;
  total_contracts: number | null;
  option_type: string | null;
  direction: string | null;
  position_type: string | null;
  // Earnings date of the position's campaign, null when unresolved.
  campaign_earnings_date: string | null;
};

export type TradedEvent = { symbol: string; earningsDate: string };

export type TradedLeg = {
  broker: string | null;
  strike: number | null;
  // Contracts opened on this leg.
  contracts: number | null;
  openedDate: string;
  isOpen: boolean;
  // Open contracts on this leg; 0 when not open, null when unknown.
  openContracts: number | null;
  // status=open but expiry already passed — real state unknown.
  pastExpiry: boolean;
  // Open legs only; null = unknown (missing strike or fills).
  capital: number | null;
};

export type TradedStatus =
  | {
      status: "synced";
      legs: TradedLeg[];
      // Sum over open legs; null when any open leg's capital is unknown.
      openCapital: number | null;
      // null when any open leg's contract count is unknown.
      openContracts: number | null;
      // Legs still marked open past their expiry (excluded from both sums).
      staleOpenLegs: number;
    }
  | { status: "manual"; markedAt: string }
  | { status: "none" };

export function tradedKey(symbol: string, earningsDate: string): string {
  return `${symbol.toUpperCase()}|${earningsDate.slice(0, 10)}`;
}

function isShortPutOption(p: TradedPositionRow): boolean {
  return (
    p.option_type === "put" &&
    p.direction === "short" &&
    p.position_type !== "stock_long" &&
    p.position_type !== "stock_short"
  );
}

function belongsToEvent(p: TradedPositionRow, earningsDate: string): boolean {
  if (p.campaign_earnings_date) return p.campaign_earnings_date.slice(0, 10) === earningsDate;
  return p.opened_date.slice(0, 10) <= earningsDate && p.expiry.slice(0, 10) >= earningsDate;
}

// Synced beats manual: once the broker sync has the real fill, the
// manual mark is redundant and the chip shows what actually traded.
export function resolveTradedStatus(
  events: readonly TradedEvent[],
  positions: readonly TradedPositionRow[],
  manualMarks: ReadonlyMap<string, string>,
  todayIso: string,
): Map<string, TradedStatus> {
  const today = todayIso.slice(0, 10);
  const out = new Map<string, TradedStatus>();
  for (const ev of events) {
    const key = tradedKey(ev.symbol, ev.earningsDate);
    const date = ev.earningsDate.slice(0, 10);
    const sym = ev.symbol.toUpperCase();
    const legs = positions
      .filter((p) => p.symbol.toUpperCase() === sym && isShortPutOption(p) && belongsToEvent(p, date))
      .map((p): TradedLeg => {
        const strike = p.strike === null || p.strike === "" ? null : Number(p.strike);
        const pastExpiry = p.status === "open" && p.expiry.slice(0, 10) < today;
        const isOpen = p.status === "open" && !pastExpiry;
        const capital =
          !isOpen ? null : strike === null || !Number.isFinite(strike) || p.open_contracts === null ? null : strike * 100 * p.open_contracts;
        return {
          broker: p.broker,
          strike,
          contracts: p.total_contracts,
          openedDate: p.opened_date.slice(0, 10),
          isOpen,
          pastExpiry,
          capital,
          openContracts: isOpen ? p.open_contracts : 0,
        };
      })
      .sort((a, b) => a.openedDate.localeCompare(b.openedDate) || (b.strike ?? 0) - (a.strike ?? 0));
    if (legs.length > 0) {
      const open = legs.filter((l) => l.isOpen);
      const openCapital = open.some((l) => l.capital === null) ? null : open.reduce((s, l) => s + (l.capital ?? 0), 0);
      const openContracts = open.some((l) => l.openContracts === null)
        ? null
        : open.reduce((s, l) => s + (l.openContracts ?? 0), 0);
      const staleOpenLegs = legs.filter((l) => l.pastExpiry).length;
      out.set(key, { status: "synced", legs, openCapital, openContracts, staleOpenLegs });
      continue;
    }
    const markedAt = manualMarks.get(key);
    out.set(key, markedAt ? { status: "manual", markedAt } : { status: "none" });
  }
  return out;
}

// One-line tooltip summary of synced legs: "Robinhood 2× $150 · Nov 4".
export function describeTradedLegs(legs: readonly TradedLeg[]): string {
  return legs
    .map((l) => {
      const broker = l.broker ? brokerLabel(l.broker) : "Broker";
      const qty = l.contracts !== null ? `${l.contracts}× ` : "";
      const strike = l.strike !== null ? `$${l.strike % 1 === 0 ? l.strike.toFixed(0) : l.strike.toFixed(2)}` : "—";
      return `${broker} ${qty}${strike} · opened ${l.openedDate}${l.pastExpiry ? " · past expiry, still marked open" : l.isOpen ? "" : " · closed"}`;
    })
    .join("\n");
}

function brokerLabel(b: string): string {
  if (b === "robinhood") return "Robinhood";
  if (b === "schwab") return "Schwab";
  if (b === "schwab2") return "Schwab 2";
  return b;
}

// Request parsing for /api/screener/traded, here so it's unit-tested.
// parseTradedEvents returns null on any malformed segment (the route
// answers 400); empty segments from a trailing comma are skipped.
export const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shape AND calendar validity: 2026-13-45 matches DATE_RE but isn't a date.
export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function parseTradedEvents(param: string | null): TradedEvent[] | null {
  if (!param) return [];
  const seen = new Set<string>();
  const out: TradedEvent[] = [];
  for (const part of param.split(",")) {
    if (part.trim() === "") continue;
    const [rawSym, rawDate] = part.trim().split(":");
    const symbol = (rawSym ?? "").toUpperCase();
    const earningsDate = rawDate ?? "";
    if (!SYMBOL_RE.test(symbol) || !isIsoDate(earningsDate)) return null;
    const key = tradedKey(symbol, earningsDate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, earningsDate });
  }
  return out;
}

