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
import { fetchAndStoreEarningsRelease } from "./earnings-release-capture";

export const FILING_STAGE_A_RETRY_DAYS = 5;

// A genuine earnings press release, even for a small-cap, runs several
// thousand words once stripped to plain text. Anything under this is
// far more likely a broken/redirected/interstitial fetch than a
// legitimately terse release — guards the exact "silently-empty stdin
// produces an analysis of nothing" failure mode (2026-09-09 design
// review). Distinct from, and stricter than, fetchAndStoreEarningsRelease's
// own 200-char floor, which only guards the Perplexity numeric
// extraction, not whether the document is fit to hand a model as "the
// filing."
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

export type StageAOutcome =
  | { symbol: string; outcome: "captured"; quarter: string; strippedChars: number; analysisChars: number }
  | { symbol: string; outcome: "no_release_found"; detail: string }
  | { symbol: string; outcome: "document_too_short"; strippedChars: number }
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
  | { ok: true; quarter: string; filingDate: string; pressText: string }
  | { ok: false; outcome: StageAOutcome }
> {
  const result = await fetchAndStoreEarningsRelease(candidate.symbol, {
    earningsHistoryId: candidate.earningsHistoryId,
  });
  await recordAncillaryAttempt({
    earningsHistoryId: candidate.earningsHistoryId,
    symbol: candidate.symbol,
    earningsDate: candidate.earningsDate,
    phase: "filing-8k",
    outcome: result.ok ? "captured" : result.error,
  });
  if (!result.ok) {
    return { ok: false, outcome: { symbol: candidate.symbol, outcome: "no_release_found", detail: result.error } };
  }
  if (result.pressText.length < MIN_EXHIBIT_CHARS) {
    return {
      ok: false,
      outcome: { symbol: candidate.symbol, outcome: "document_too_short", strippedChars: result.pressText.length },
    };
  }
  return { ok: true, quarter: result.quarter, filingDate: result.filingDate, pressText: result.pressText };
}
