// Cron-driven T0/T1 IV-crush capture. Called by the Mac mini crontab
// via /api/earnings/capture-t0 and /api/earnings/capture-t1 at the two
// moments that matter:
//   T0 — 15:45 ET on a report day (~15 min before the close), so
//        iv_before / implied move are measured with the earnings
//        premium fully priced in.
//   T1 — 09:45 ET the next session (~15 min after the open), after
//        the post-print IV crush has settled out of the opening auction.
// Everything here is best-effort and idempotent: reruns skip rows that
// already carry the capture, and a Schwab outage logs the miss and
// exits gracefully (the T1 window tolerates up to 4 days of misses).
import { createServerClient } from "@/lib/supabase";
import { isSchwabConnected } from "@/lib/schwab";
import {
  captureEarningsT0,
  captureEarningsT1,
  recalculateStats,
  selectT0Candidates,
  selectT1Candidates,
  type T0Candidate,
  type T1Candidate,
} from "@/lib/encyclopedia";
import { analyzePositionPostEarnings } from "@/lib/post-earnings";
import type { PositionRow } from "@/lib/positions";
import { isT1SessionEligible } from "@/lib/session-eligibility";
import { recordCaptureAttempt, markT1RowsUnrecoverable, T1_RETRY_CUTOFF_DAYS } from "@/lib/earnings-capture-attempts";
import { upsertHealthRollup } from "@/lib/capture-health";

// Distinct phase labels for capture_health_daily — NOT "t0"/"t1", which
// scripts/capture-t0-t1-chain-detail.ts already writes for a completely
// different mechanism (per-strike chain-detail capture around T0/T1,
// not this file's earnings_history actual-move capture). Reusing those
// labels would recreate exactly the banner conflation the 2026-08-11
// audit found — see components/capture-health-panel.tsx's
// CrushCaptureHealthPanel, which reads these specific labels.
const CRUSH_T0_PHASE = "crush-t0";
const CRUSH_T1_PHASE = "crush-t1";

// Benign, expected skip reasons — never real failures, so excluded from
// the errored/outstanding counts a health rollup reports. Same
// vocabulary already returned by captureEarningsT0/T1 (see CaptureItem).
const BENIGN_SKIP_REASONS = new Set(["already_captured", "manual_row", "row_not_found", "no_t0_data"]);

async function writeCrushHealthRollup(
  phase: typeof CRUSH_T0_PHASE | typeof CRUSH_T1_PHASE,
  captureDate: string,
  report: CaptureReport,
  runStartedAt: string,
  runFinishedAt: string,
): Promise<void> {
  const schwabDisconnected = report.skipped.filter((s) => s.reason === "schwab_disconnected").length;
  const realFailures = report.skipped.filter(
    (s) => s.reason !== "schwab_disconnected" && !(s.reason && BENIGN_SKIP_REASONS.has(s.reason)),
  );
  await upsertHealthRollup(captureDate, phase, {
    due: report.candidates,
    fired: report.captured.length,
    errored: realFailures.length,
    suppressed: 0,
    missed: 0,
    schwab_disconnected: schwabDisconnected,
    outstanding: realFailures.map((s) => ({
      symbol: s.symbol,
      earnings_history_id: null,
      earnings_date: s.earnings_date,
      trading_day_offset: null,
    })),
    run_started_at: runStartedAt,
    run_finished_at: runFinishedAt,
  });
}

// Re-exported for existing importers. isT1SessionEligible's canonical
// definition lives in lib/session-eligibility.ts so lib/encyclopedia.ts
// can use the identical check without a circular import (encyclopedia.ts
// is already imported by this file). selectT0Candidates/selectT1Candidates
// moved to lib/encyclopedia.ts 2026-08-05 so runEncyclopediaMaintenance's
// T0/T1 passes can call the SAME selection logic this file's
// runT0Capture/runT1Capture use, instead of maintaining an independent,
// driftable duplicate — which is exactly what let a same-session AMC
// capture through.
export { isT1SessionEligible, selectT0Candidates, selectT1Candidates };
export type { T0Candidate, T1Candidate };

// Leave headroom inside Vercel Hobby's 60s ceiling for the response to
// flush. Chain fetches are 1-3s each, so this covers ~15-25 symbols —
// far above a normal day's relevant-reporter count.
const CAPTURE_BUDGET_MS = 50_000;

export function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type CaptureItem = {
  symbol: string;
  earnings_date: string;
  captured: boolean;
  reason?: string;
  // T0 payload when captured
  iv_before?: number;
  implied_move_pct?: number;
  price_before?: number;
  // T1 payload when captured
  iv_after?: number;
  iv_crush_magnitude?: number;
  move_ratio?: number;
  iv_crushed?: boolean;
  // positions stamped with earnings_history_id for this event
  positions_linked?: string[];
  // post-earnings recommendations generated for linked positions (T1)
  recommendations?: Array<{
    position_id: string;
    recommendation: string;
    confidence: string;
    rule_fired: string;
  }>;
};

export type CaptureReport = {
  ok: boolean;
  dryRun: boolean;
  skipReason?: string;
  candidates: number;
  captured: CaptureItem[];
  skipped: CaptureItem[];
  budget_exhausted: boolean;
};

// Stamp earnings_history_id on every open option position that spans
// the event (expiry on/after the report date) and isn't linked yet.
// This is a cross-user maintenance sweep by design (same pattern as the
// pass3 snapshot sweep): each owner's rows get the shared event id.
async function linkOpenPositions(
  symbol: string,
  earningsDate: string,
  dryRun: boolean,
): Promise<string[]> {
  const sb = createServerClient();
  const ev = await sb
    .from("earnings_history")
    .select("id")
    .eq("symbol", symbol)
    .eq("earnings_date", earningsDate)
    .limit(1);
  const eventId = ((ev.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  if (!eventId && !dryRun) return [];

  const posRes = await sb
    .from("positions")
    .select("id,expiry,position_type,earnings_history_id")
    .eq("symbol", symbol)
    .eq("status", "open");
  if (posRes.error) {
    console.warn(
      `[earnings-capture] position lookup(${symbol}) failed: ${posRes.error.message}`,
    );
    return [];
  }
  const candidates = ((posRes.data ?? []) as Array<{
    id: string;
    expiry: string;
    position_type: string | null;
    earnings_history_id: string | null;
  }>).filter(
    (p) =>
      p.position_type !== "stock_long" &&
      p.position_type !== "stock_short" &&
      p.earnings_history_id === null &&
      p.expiry >= earningsDate,
  );
  if (candidates.length === 0) return [];
  if (dryRun) return candidates.map((p) => p.id);

  const upd = await sb
    .from("positions")
    .update({ earnings_history_id: eventId, updated_at: new Date().toISOString() })
    .in(
      "id",
      candidates.map((p) => p.id),
    );
  if (upd.error) {
    console.warn(
      `[earnings-capture] position link(${symbol}) failed: ${upd.error.message}`,
    );
    return [];
  }
  return candidates.map((p) => p.id);
}

// T0 candidates: today's AMC + tomorrow's BMO reporters from the
// Finnhub calendar, restricted to symbols the app already knows
// (open positions, today's tracked tickers, encyclopedia entries) so
// we never fetch chains for the whole market — UNIONED with any
// pre-ingested earnings_history rows dated today/tomorrow that still
// lack iv_before. captureEarningsT0 upserts the earnings_history stub
// for calendar-sourced symbols, so both paths end in a linked row.
export async function runT0Capture(opts?: {
  dryRun?: boolean;
  // Test hook: capture exactly these {symbol, date} pairs, skipping
  // calendar + relevance selection. Used by the dry-run simulator.
  only?: Array<{ symbol: string; earnings_date: string; timing?: "amc" | "bmo" | "unknown" }>;
}): Promise<CaptureReport> {
  const dryRun = opts?.dryRun === true;
  const runStartedAt = new Date().toISOString();
  const captureDate = todayEasternIso();
  const report: CaptureReport = {
    ok: true,
    dryRun,
    candidates: 0,
    captured: [],
    skipped: [],
    budget_exhausted: false,
  };

  const connected = await isSchwabConnected()
    .then((r) => r.connected)
    .catch(() => false);
  if (!connected) {
    console.warn("[earnings-capture:T0] Schwab disconnected — capture skipped");
    const disconnectedReport = { ...report, ok: false, skipReason: "schwab_disconnected" };
    if (!dryRun) {
      await writeCrushHealthRollup(CRUSH_T0_PHASE, captureDate, disconnectedReport, runStartedAt, new Date().toISOString());
    }
    return disconnectedReport;
  }

  let candidates: T0Candidate[];
  if (opts?.only && opts.only.length > 0) {
    candidates = opts.only.map((c) => ({
      symbol: c.symbol.toUpperCase(),
      earnings_date: c.earnings_date,
      timing: c.timing ?? "unknown",
    }));
  } else {
    candidates = await selectT0Candidates();
  }

  report.candidates = candidates.length;
  const startedAt = Date.now();
  for (const c of candidates) {
    if (Date.now() - startedAt > CAPTURE_BUDGET_MS) {
      report.budget_exhausted = true;
      console.warn(
        `[earnings-capture:T0] budget exhausted with ${report.captured.length}/${candidates.length} captured — rest defers`,
      );
      break;
    }
    try {
      const r = await captureEarningsT0(c.symbol, c.earnings_date, { dryRun, timing: c.timing });
      if (!dryRun) {
        await recordCaptureAttempt({
          earningsHistoryId: null,
          symbol: c.symbol,
          earningsDate: c.earnings_date,
          phase: "t0",
          outcome: r.captured ? "captured" : (r.reason ?? "unknown"),
        });
      }
      if (r.captured) {
        const linked = await linkOpenPositions(c.symbol, c.earnings_date, dryRun);
        report.captured.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          captured: true,
          iv_before: r.iv_before,
          implied_move_pct: r.implied_move_pct,
          price_before: r.price_before,
          positions_linked: linked,
        });
      } else {
        // Already-captured events still deserve the position link — a
        // position opened after an earlier T0 run would otherwise
        // never get stamped.
        const linked =
          r.reason === "already_captured"
            ? await linkOpenPositions(c.symbol, c.earnings_date, dryRun)
            : [];
        report.skipped.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          captured: false,
          reason: r.reason,
          positions_linked: linked,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "threw";
      if (!dryRun) {
        await recordCaptureAttempt({
          earningsHistoryId: null,
          symbol: c.symbol,
          earningsDate: c.earnings_date,
          phase: "t0",
          outcome: message,
          errorMessage: message,
        });
      }
      report.skipped.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        captured: false,
        reason: message,
      });
    }
  }
  if (!dryRun) {
    await writeCrushHealthRollup(CRUSH_T0_PHASE, captureDate, report, runStartedAt, new Date().toISOString());
  }
  return report;
}

// After a T1 capture lands, run the post-earnings rec engine for every
// OPEN position linked to the event via earnings_history_id (stamped at
// T0 / at entry). analyzePositionPostEarnings reads the fresh
// move_ratio / iv_crushed off earnings_history, applies the rule
// cascade, and upserts one rec per (position, day) — this was the
// audit's "orphaned engine with zero call sites."
async function generatePostEarningsRecs(
  symbol: string,
  earningsDate: string,
  dryRun: boolean,
): Promise<CaptureItem["recommendations"]> {
  const sb = createServerClient();
  const ev = await sb
    .from("earnings_history")
    .select("id")
    .eq("symbol", symbol.toUpperCase())
    .eq("earnings_date", earningsDate)
    .limit(1);
  const eventId = ((ev.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  if (!eventId) return [];

  const posRes = await sb
    .from("positions")
    .select("*")
    .eq("earnings_history_id", eventId)
    .eq("status", "open");
  if (posRes.error) {
    console.warn(
      `[earnings-capture:T1] linked-position lookup(${symbol}) failed: ${posRes.error.message}`,
    );
    return [];
  }
  const positions = (posRes.data ?? []) as PositionRow[];
  if (positions.length === 0) return [];
  if (dryRun) {
    return positions.map((p) => ({
      position_id: p.id,
      recommendation: "DRY_RUN",
      confidence: "-",
      rule_fired: "-",
    }));
  }

  const out: NonNullable<CaptureItem["recommendations"]> = [];
  for (const p of positions) {
    try {
      const rec = await analyzePositionPostEarnings(p);
      if (rec) {
        out.push({
          position_id: p.id,
          recommendation: rec.recommendation,
          confidence: rec.confidence,
          rule_fired: rec.rule_fired,
        });
      }
    } catch (e) {
      console.warn(
        `[earnings-capture:T1] rec generation failed for position ${p.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return out;
}

// T1 candidates: earnings_history rows with a T0 capture (iv_before
// set) and no T1 yet, dated within the trailing T1_RETRY_CUTOFF_DAYS
// (10) — retried every eligible run until captured or the cutoff is
// reached, at which point markT1RowsUnrecoverable (below) explicitly
// marks the row dead rather than leaving it silently incomplete. Was a
// fixed 4-day window with no retry — see
// lib/earnings-capture-attempts.ts's header for the audit that found
// this orphaning rows permanently. Self-pairing: only events we
// actually T0'd are eligible, which is exactly the set a crush number
// is computable for.
export async function runT1Capture(opts?: {
  dryRun?: boolean;
}): Promise<CaptureReport> {
  const dryRun = opts?.dryRun === true;
  const runStartedAt = new Date().toISOString();
  const captureDate = todayEasternIso();
  const report: CaptureReport = {
    ok: true,
    dryRun,
    candidates: 0,
    captured: [],
    skipped: [],
    budget_exhausted: false,
  };

  const connected = await isSchwabConnected()
    .then((r) => r.connected)
    .catch(() => false);
  if (!connected) {
    console.warn("[earnings-capture:T1] Schwab disconnected — capture skipped");
    const disconnectedReport = { ...report, ok: false, skipReason: "schwab_disconnected" };
    if (!dryRun) {
      await writeCrushHealthRollup(CRUSH_T1_PHASE, captureDate, disconnectedReport, runStartedAt, new Date().toISOString());
    }
    return disconnectedReport;
  }

  if (!dryRun) {
    const aged = await markT1RowsUnrecoverable(captureDate);
    if (aged.length > 0) {
      console.warn(
        `[earnings-capture:T1] ${aged.length} row(s) aged past the ${T1_RETRY_CUTOFF_DAYS}-day cutoff, marked unrecoverable: ` +
          aged.map((a) => `${a.symbol}@${a.earnings_date} (${a.reason})`).join(", "),
      );
    }
  }

  const candidates = await selectT1Candidates();

  report.candidates = candidates.length;
  const startedAt = Date.now();
  const recalcSymbols = new Set<string>();
  for (const c of candidates) {
    if (Date.now() - startedAt > CAPTURE_BUDGET_MS) {
      report.budget_exhausted = true;
      console.warn(
        `[earnings-capture:T1] budget exhausted with ${report.captured.length}/${candidates.length} captured — rest defers to the next eligible run (${T1_RETRY_CUTOFF_DAYS}-day window)`,
      );
      break;
    }
    try {
      const r = await captureEarningsT1(c.symbol, c.earnings_date, { dryRun });
      if (!dryRun) {
        await recordCaptureAttempt({
          earningsHistoryId: c.id,
          symbol: c.symbol,
          earningsDate: c.earnings_date,
          phase: "t1",
          outcome: r.captured ? "captured" : (r.reason ?? "unknown"),
          // Only ever set on too_early_capture/corrupted_t0_baseline —
          // checkAndMarkCorruptedBaseline reads it back off the last two
          // attempt rows to detect a recurring, unchanging magnitude.
          errorMessage: !r.captured && r.iv_crush_magnitude !== undefined ? String(r.iv_crush_magnitude) : null,
        });
      }
      if (r.captured) {
        recalcSymbols.add(c.symbol.toUpperCase());
        // Post-earnings recommendation engine: every position linked to
        // this event (the T0 spine stamp) gets a verdict computed from
        // the crush data that just landed. Best-effort per position.
        const recommendations = await generatePostEarningsRecs(
          c.symbol,
          c.earnings_date,
          dryRun,
        );
        report.captured.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          captured: true,
          iv_before: c.iv_before ?? undefined,
          iv_crush_magnitude: r.iv_crush_magnitude,
          move_ratio: r.move_ratio,
          iv_crushed: r.iv_crushed,
          recommendations,
        });
      } else {
        report.skipped.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          captured: false,
          reason: r.reason,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "threw";
      if (!dryRun) {
        await recordCaptureAttempt({
          earningsHistoryId: c.id,
          symbol: c.symbol,
          earningsDate: c.earnings_date,
          phase: "t1",
          outcome: message,
          errorMessage: message,
        });
      }
      report.skipped.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        captured: false,
        reason: message,
      });
    }
  }

  // Roll the fresh crush numbers into the shared encyclopedia
  // aggregates (crush_rate, avg_iv_crush_magnitude, avg_move_ratio).
  if (!dryRun) {
    for (const sym of Array.from(recalcSymbols)) {
      try {
        await recalculateStats(sym);
      } catch (e) {
        console.warn(
          `[earnings-capture:T1] recalculateStats(${sym}) failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    await writeCrushHealthRollup(CRUSH_T1_PHASE, captureDate, report, runStartedAt, new Date().toISOString());
  }
  return report;
}
