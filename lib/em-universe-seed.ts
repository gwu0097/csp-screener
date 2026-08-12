// Scheduled implied-move universe seeding sweep.
//
// This job does NOT call Schwab and does NOT capture implied_move_pct
// itself. It only ensures an earnings_history stub row (symbol,
// earnings_date, timing) exists for the chosen universe ahead of each
// print. The existing captureEarningsT0/T1 pipeline (lib/encyclopedia.ts,
// scheduled via com.csp.crush-t0/crush-t1) then picks the row up
// automatically: selectT0Candidates()'s source 2 matches ANY
// earnings_history row dated today/tomorrow with iv_before IS NULL,
// with no relevance filter at all. So seeding a row here is sufficient
// — the actual Schwab chain fetch, the manual-row guard, the
// already_captured gate, the budget ceiling, and the retry pass are all
// inherited unchanged from that pipeline. This keeps the new job's own
// external footprint to a single bulk Finnhub calendar call per run.
//
// Why a broader universe needs its own job at all: selectT0Candidates()
// source 1 (today's Finnhub calendar) is filtered to "relevant" symbols
// (buildMaintenanceSymbolSets() — open positions / tracked tickers).
// Source 2 only helps a symbol that ALREADY has a seeded row. A symbol
// with zero footprint in either bucket never enters T0's candidate list
// at all, regardless of how the crons are scheduled — this job exists
// to close that gap.
import { getUpcomingEarnings, getSupplementalWhitelistEarnings, type EarningsCalendarItem } from "./earnings";
import { isQuarterEndDate, readHistoryRow, upsertHistoryStub } from "./encyclopedia";
import { recordAncillaryAttempt } from "./earnings-capture-attempts";
import { SWING_UNIVERSE } from "./stock-universe";

// Same wall-clock discipline as runT0Capture/runT1Capture
// (lib/earnings-capture.ts) — bounded well under Vercel's ~60s function
// ceiling so a slow run degrades to "did some, will finish next run"
// instead of timing out mid-write.
const SEED_BUDGET_MS = 50_000;

// Forward window for the seed sweep. T0 only needs ≥1 day of lead time
// (selectT0Candidates source 2 checks today/tomorrow), but seeding
// several days ahead means a transient failure of THIS job on any one
// day doesn't cost a print — the row still gets seeded on a later run
// before its own earnings_date arrives.
const SEED_FORWARD_DAYS = 5;

// Finnhub's bulk /calendar/earnings range query silently omits some
// ADRs filed under a foreign primary listing (documented in
// lib/earnings.ts: TSM -> 2330.TW). getSupplementalWhitelistEarnings
// already exists for exactly this — currently used for the user's own
// watchlist. Applying it to the FULL 520-symbol universe would mean a
// per-symbol Finnhub call for every miss, most of which just aren't
// reporting that day — not an ADR gap. Bounded here to the one
// documented case instead of guessing at a broader list.
const KNOWN_ADR_GAPS = ["TSM"];

export type SeedOutcome = "seeded" | "already_exists" | "quarter_end_skip" | string;

export type SeedReport = {
  ok: boolean;
  dryRun: boolean;
  scopeSize: number;
  candidates: number;
  seeded: Array<{ symbol: string; earnings_date: string; timing: string }>;
  alreadyExists: Array<{ symbol: string; earnings_date: string }>;
  skipped: Array<{ symbol: string; earnings_date: string; reason: string }>;
  errors: Array<{ symbol: string; earnings_date: string; reason: string }>;
  budget_exhausted: boolean;
};

export async function runEmUniverseSeed(opts?: { dryRun?: boolean }): Promise<SeedReport> {
  const dryRun = opts?.dryRun === true;
  const startedAt = Date.now();
  const scope = new Set(SWING_UNIVERSE.map((s) => s.toUpperCase()));

  const report: SeedReport = {
    ok: true,
    dryRun,
    scopeSize: scope.size,
    candidates: 0,
    seeded: [],
    alreadyExists: [],
    skipped: [],
    errors: [],
    budget_exhausted: false,
  };

  // Bulk call — covers the whole market in one request, not per-symbol.
  let calendar: EarningsCalendarItem[];
  try {
    calendar = await getUpcomingEarnings(SEED_FORWARD_DAYS);
  } catch (e) {
    report.ok = false;
    report.errors.push({
      symbol: "",
      earnings_date: "",
      reason: `getUpcomingEarnings failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return report;
  }
  // getUpcomingEarnings swallows its own Finnhub failures internally
  // (429s, network errors) and returns [] either way — indistinguishable
  // from a genuinely quiet calendar. Across a 5-day forward window, the
  // whole market returning zero reporters is implausible; treat it as a
  // suspected upstream failure and log a visible sentinel rather than
  // silently reporting a clean "0 candidates" run.
  if (calendar.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    report.errors.push({
      symbol: "",
      earnings_date: today,
      reason: "empty_calendar_response — likely upstream Finnhub failure, not a genuinely quiet day",
    });
    if (!dryRun) {
      await recordAncillaryAttempt({
        earningsHistoryId: null,
        symbol: "__calendar__",
        earningsDate: today,
        phase: "em-seed",
        outcome: "empty_calendar_response",
      }).catch(() => {});
    }
  }

  const inScope = calendar.filter((e) => scope.has(e.symbol.toUpperCase()));
  const foundSymbols = new Set(inScope.map((e) => e.symbol.toUpperCase()));

  // Bounded ADR fallback — only for known gaps that are (a) in scope and
  // (b) not already found by the bulk call.
  const missingAdrGaps = KNOWN_ADR_GAPS.filter(
    (s) => scope.has(s) && !foundSymbols.has(s),
  );
  if (missingAdrGaps.length > 0) {
    try {
      const supplemental = await getSupplementalWhitelistEarnings(missingAdrGaps);
      inScope.push(...supplemental);
    } catch (e) {
      report.errors.push({
        symbol: missingAdrGaps.join(","),
        earnings_date: "",
        reason: `getSupplementalWhitelistEarnings failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  report.candidates = inScope.length;

  for (const e of inScope) {
    if (Date.now() - startedAt > SEED_BUDGET_MS) {
      report.budget_exhausted = true;
      break;
    }
    const symbol = e.symbol.toUpperCase();
    const earningsDate = e.date;
    const timing: "amc" | "bmo" | "unknown" =
      e.timing === "AMC" ? "amc" : e.timing === "BMO" ? "bmo" : "unknown";

    // Real announcement dates from the Finnhub calendar should never be
    // a quarter-end placeholder, but this guard costs nothing to check
    // and the constraint was explicit about respecting it.
    if (isQuarterEndDate(earningsDate)) {
      report.skipped.push({ symbol, earnings_date: earningsDate, reason: "quarter_end_skip" });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: null,
          symbol,
          earningsDate,
          phase: "em-seed",
          outcome: "quarter_end_skip",
        }).catch(() => {});
      }
      continue;
    }

    try {
      const existing = await readHistoryRow(symbol, earningsDate);
      if (existing) {
        report.alreadyExists.push({ symbol, earnings_date: earningsDate });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: null,
            symbol,
            earningsDate,
            phase: "em-seed",
            outcome: "already_exists",
          }).catch(() => {});
        }
        continue;
      }
      if (!dryRun) {
        // upsertHistoryStub also has its own drift guard (merges onto
        // an existing row within 10 days instead of duplicating) — the
        // readHistoryRow check above is only for accurate "seeded" vs
        // "already_exists" reporting, upsertHistoryStub is still the
        // one that actually writes.
        await upsertHistoryStub(symbol, earningsDate, timing);
      }
      report.seeded.push({ symbol, earnings_date: earningsDate, timing });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: null,
          symbol,
          earningsDate,
          phase: "em-seed",
          outcome: "seeded",
        }).catch(() => {});
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.errors.push({ symbol, earnings_date: earningsDate, reason: message });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: null,
          symbol,
          earningsDate,
          phase: "em-seed",
          outcome: "error",
          errorMessage: message,
        }).catch(() => {});
      }
    }
  }

  return report;
}
