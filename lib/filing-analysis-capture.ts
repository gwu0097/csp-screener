// Earnings Reports Stage A: same-day 8-K capture. Finds earnings_history
// rows whose 8-K earnings release hasn't been captured yet, pulls it via
// the shared fetchAndStoreEarningsRelease (lib/earnings-release-capture.ts),
// and — this module's own addition — runs a claude -p pass over the
// press-release exhibit text to produce the guidance/commentary half of
// the Earnings Reports analysis (items 1-2; items 3-4 are Stage B, once
// the 10-Q lands, not built yet).
//
// Retry window: 8-K item 2.02 filing basically IS the earnings
// announcement (it's how earnings_date itself gets resolved for most
// symbols), so same-day/next-day is the overwhelmingly common case — a
// 5-day window is generous headroom for a late/delayed filer, not a
// measured lag distribution the way T1's 10-day 10-Q window is.
import { createServerClient } from "./supabase";
import { recordAncillaryAttempt } from "./earnings-capture-attempts";
import {
  fetchAndStoreEarningsRelease,
  type EarningsReleaseCaptureFailureReason,
} from "./earnings-release-capture";

export const FILING_STAGE_A_RETRY_DAYS = 5;

// A genuine earnings press release, even for a small-cap, runs several
// thousand words once stripped to plain text. Anything under this is
// far more likely a broken/redirected/interstitial fetch than a
// legitimately terse release — guards the exact "silently-empty stdin
// produces an analysis of nothing" failure mode (2026-09-09 design
// review).
//
// Passed into fetchAndStoreEarningsRelease as minPressTextChars, NOT
// checked separately after the fact — checking it after that call
// returns is too late: that function has already run Perplexity and
// written+linked the earnings_releases row by the time it returns, so
// a post-hoc check here would only skip the claude -p step while still
// permanently marking the candidate handled (earnings_history_id now
// linked, selectStageACandidates would never offer it again). Caught
// on review (2026-09-09) before the plist was loaded — the original
// version had exactly that gap: a 200-2,999-char document would get
// its numbers written and get silently retired from retry, with only
// a one-time Discord post as the record. Passing the floor in means a
// short document is refused before any write happens, so it stays
// eligible for retry on the next run.
export const MIN_EXHIBIT_CHARS = 3_000;

export type StageACandidate = {
  earningsHistoryId: string;
  symbol: string;
  earningsDate: string;
  timing: "amc" | "bmo" | "unknown" | null;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// True once today is the LAST day selectStageACandidates would still
// offer this earnings_date (its earnings_date equals the window's
// floor, today - FILING_STAGE_A_RETRY_DAYS) — tomorrow it ages out of
// the query entirely. A no_release_found outcome before this point is
// the expected state for a same-week AMC/BMO reporter (the 8-K
// legitimately doesn't exist yet); only once the window is about to
// close does "still nothing" mean something worth a human look, same
// distinction as T1's corrupted-baseline detector firing on persistent
// signal rather than every retry (2026-09-09).
export function isLastStageARetryDay(earningsDate: string, todayEt: string): boolean {
  return earningsDate === addDaysIso(todayEt, -FILING_STAGE_A_RETRY_DAYS);
}

// Pure selection — no EDGAR/Perplexity/claude calls, safe to call from
// anywhere. Candidates: earnings_history rows with earnings_date in the
// trailing FILING_STAGE_A_RETRY_DAYS window, not a hand-entered row
// (same manual-row protection as T0/T1 — implied_move_source==='manual'
// means a user typed this row in by hand and automation must never
// touch it), that don't already have a linked earnings_releases row.
//
// Two queries + a JS filter rather than a join: the custom Supabase
// wrapper (lib/supabase.ts) doesn't support relational embeds, and the
// candidate set here is always small (one earnings_date window), so
// there's no need to work around the ~1000-row cap the way larger
// scans in this codebase do.
export async function selectStageACandidates(todayEt: string): Promise<StageACandidate[]> {
  const sb = createServerClient();
  const since = addDaysIso(todayEt, -FILING_STAGE_A_RETRY_DAYS);
  const res = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date,timing,implied_move_source")
    .gte("earnings_date", since)
    .lte("earnings_date", todayEt);
  if (res.error) {
    console.warn(`[filing-analysis-capture] candidate query failed: ${res.error.message}`);
    return [];
  }
  const rows = (res.data ?? []) as Array<{
    id: string;
    symbol: string;
    earnings_date: string;
    timing: "amc" | "bmo" | "unknown" | null;
    implied_move_source: string | null;
  }>;
  const eligible = rows.filter((r) => r.implied_move_source !== "manual");
  if (eligible.length === 0) return [];

  const ids = eligible.map((r) => r.id);
  const linked = await sb
    .from("earnings_releases")
    .select("earnings_history_id")
    .in("earnings_history_id", ids);
  const linkedIds = new Set(
    ((linked.data ?? []) as Array<{ earnings_history_id: string | null }>)
      .map((r) => r.earnings_history_id)
      .filter((id): id is string => id !== null),
  );

  return eligible
    .filter((r) => !linkedIds.has(r.id))
    .map((r) => ({
      earningsHistoryId: r.id,
      symbol: r.symbol,
      earningsDate: r.earnings_date,
      timing: r.timing,
    }));
}

// Single-symbol override for testing/backfill — same purpose as T0's
// own ?symbol=&date= affordance (lib/encyclopedia.ts's captureEarningsT0
// comment). Looks up that symbol's most recent earnings_history row
// directly, bypassing the date window, but keeps the same manual-row
// and already-linked guards a real candidate would go through.
export async function selectStageACandidateBySymbol(symbol: string): Promise<StageACandidate | null> {
  const sb = createServerClient();
  const res = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date,timing,implied_move_source")
    .eq("symbol", symbol.toUpperCase())
    .order("earnings_date", { ascending: false })
    .limit(1);
  if (res.error || !res.data || res.data.length === 0) return null;
  const r = res.data[0] as {
    id: string;
    symbol: string;
    earnings_date: string;
    timing: "amc" | "bmo" | "unknown" | null;
    implied_move_source: string | null;
  };
  if (r.implied_move_source === "manual") return null;
  const linked = await sb
    .from("earnings_releases")
    .select("id")
    .eq("earnings_history_id", r.id)
    .limit(1);
  if (!linked.error && (linked.data ?? []).length > 0) return null;
  return { earningsHistoryId: r.id, symbol: r.symbol, earningsDate: r.earnings_date, timing: r.timing };
}

// "no_release_found" covers every pre-write failure from
// fetchAndStoreEarningsRelease — no matching 8-K, exhibit not found,
// fetch failed, AND now (with minPressTextChars passed through) a
// document too short to trust. All of them share the same property
// that matters for retry: nothing was written, so the candidate stays
// eligible next run. result.error carries the specific detail
// (including the exact char count on a too-short document); `reason`
// carries the machine-readable classification a caller needs to decide
// whether this is worth a human's attention — only "not_yet_filed" is
// ever routine (the 8-K genuinely doesn't exist yet for a same-week
// reporter), every other reason means something that WAS available
// failed to process (see EarningsReleaseCaptureFailureReason).
export type StageAOutcome =
  | { symbol: string; outcome: "captured"; quarter: string; strippedChars: number; analysisChars: number }
  | { symbol: string; outcome: "no_release_found"; detail: string; reason: EarningsReleaseCaptureFailureReason }
  | { symbol: string; outcome: "claude_failed"; detail: string }
  | { symbol: string; outcome: "write_failed"; detail: string };

// One candidate's full Stage A pass: capture the 8-K release (numbers +
// earnings_history_id link), then hand the caller back the press text
// so it can run the local-only claude -p step (this module stays
// portable / no child_process dependency — that lives in the courier
// script, matching how lib/sec-edgar.ts stays portable and
// scripts/robinhood-courier.ts owns the execFileSync call).
export async function captureStageARelease(
  candidate: StageACandidate,
): Promise<
  | { ok: true; quarter: string; filingDate: string; pressText: string; exhibitSource: "regex" | "size_fallback" }
  | { ok: false; outcome: StageAOutcome }
> {
  const result = await fetchAndStoreEarningsRelease(candidate.symbol, {
    earningsHistoryId: candidate.earningsHistoryId,
    minPressTextChars: MIN_EXHIBIT_CHARS,
  });
  await recordAncillaryAttempt({
    earningsHistoryId: candidate.earningsHistoryId,
    symbol: candidate.symbol,
    earningsDate: candidate.earningsDate,
    phase: "filing-8k",
    outcome: result.ok ? "captured" : result.error,
  });
  if (!result.ok) {
    return {
      ok: false,
      outcome: { symbol: candidate.symbol, outcome: "no_release_found", detail: result.error, reason: result.reason },
    };
  }
  return {
    ok: true,
    quarter: result.quarter,
    filingDate: result.filingDate,
    pressText: result.pressText,
    exhibitSource: result.exhibitSource,
  };
}

// Is there an earnings_history row for this symbol whose earnings_date
// is within a few days of the 8-K's filing date? uniqueAtDistance is
// false when 2+ rows tie at the same dayDiff — a genuine possibility in
// principle (the EDGAR client's own comments document a Finnhub
// calendar-drift failure mode that can produce near-duplicate
// earnings_date rows), not observed in the current data (verified
// 2026-09-09: zero same-symbol earnings_history pairs within 10 days
// across all 3,050 rows) but the caller shouldn't rely on that staying
// true. Only dayDiff === 0 AND uniqueAtDistance is ever safe to link
// automatically — that's not an inference, it's the same event
// observed from two documents. Anything else is a real judgment call
// and stays a report, not a write.
export async function findNearestEarningsHistoryRow(
  symbol: string,
  nearIso: string,
  withinDays = 5,
): Promise<{ id: string; earningsDate: string; dayDiff: number; uniqueAtDistance: boolean } | null> {
  const sb = createServerClient();
  const since = addDaysIso(nearIso, -withinDays);
  const until = addDaysIso(nearIso, withinDays);
  const res = await sb
    .from("earnings_history")
    .select("id,earnings_date")
    .eq("symbol", symbol.toUpperCase())
    .gte("earnings_date", since)
    .lte("earnings_date", until);
  if (res.error) return null;
  const rows = (res.data ?? []) as Array<{ id: string; earnings_date: string }>;
  if (rows.length === 0) return null;
  const withDiff = rows.map((r) => ({
    id: r.id,
    earningsDate: r.earnings_date,
    dayDiff: Math.abs(new Date(r.earnings_date + "T00:00:00Z").getTime() - new Date(nearIso + "T00:00:00Z").getTime()) / 86_400_000,
  }));
  withDiff.sort((a, b) => a.dayDiff - b.dayDiff);
  const best = withDiff[0];
  const tiedCount = withDiff.filter((r) => r.dayDiff === best.dayDiff).length;
  return { ...best, uniqueAtDistance: tiedCount === 1 };
}

// Direct-symbol variant for a manual diagnostic run — no earnings_history
// dependency at all, matching the existing manual "Fetch latest 8-K"
// button exactly (same reason it also skips recordAncillaryAttempt: that
// table's earnings_date column is not-null and there may be no
// earnings_history row in scope to anchor it to).
//
// Auto-links earnings_history_id ONLY when the nearest row is an exact
// same-day match (dayDiff === 0) and unique at that distance — verified
// 2026-09-09 that's never a guess given the current data's zero-
// ambiguity property (see findNearestEarningsHistoryRow). Any gap, or a
// tie, stays unlinked and gets reported instead — matching how
// selectStageACandidates's own trigger only ever links a row it's
// certain about.
export async function captureStageAReleaseForSymbol(
  symbol: string,
): Promise<
  | {
      ok: true;
      quarter: string;
      filingDate: string;
      pressText: string;
      exhibitSource: "regex" | "size_fallback";
      linkedEarningsHistoryId: string | null;
      nearestMatch: { id: string; earningsDate: string; dayDiff: number; uniqueAtDistance: boolean } | null;
    }
  | { ok: false; outcome: StageAOutcome }
> {
  const result = await fetchAndStoreEarningsRelease(symbol, { minPressTextChars: MIN_EXHIBIT_CHARS });
  if (!result.ok) {
    return {
      ok: false,
      outcome: { symbol: symbol.toUpperCase(), outcome: "no_release_found", detail: result.error, reason: result.reason },
    };
  }
  const nearest = await findNearestEarningsHistoryRow(symbol, result.filingDate);
  let linkedEarningsHistoryId: string | null = null;
  if (nearest && nearest.dayDiff === 0 && nearest.uniqueAtDistance) {
    const sb = createServerClient();
    const patch = await sb
      .from("earnings_releases")
      .update({ earnings_history_id: nearest.id })
      .eq("symbol", symbol.toUpperCase())
      .eq("quarter", result.quarter);
    if (!patch.error) linkedEarningsHistoryId = nearest.id;
    else console.warn(`[filing-analysis-capture] ${symbol}: earnings_history_id link patch failed: ${patch.error.message}`);
  }
  return {
    ok: true,
    quarter: result.quarter,
    filingDate: result.filingDate,
    pressText: result.pressText,
    exhibitSource: result.exhibitSource,
    linkedEarningsHistoryId,
    nearestMatch: nearest,
  };
}
