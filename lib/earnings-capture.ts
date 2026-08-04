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
  buildMaintenanceSymbolSets,
  recalculateStats,
} from "@/lib/encyclopedia";
import { getTodayEarnings } from "@/lib/earnings";
import { analyzePositionPostEarnings } from "@/lib/post-earnings";
import type { PositionRow } from "@/lib/positions";

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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Session gate, not date gate — the actual fix for T1's same-session-
// AMC contamination bug. BMO: the print already happened before
// today's open, so same-day (earnings_date === todayEt) capture is
// correct — unchanged from before. AMC (or unknown timing, treated
// conservatively as AMC): the print hasn't happened yet as of this
// morning if earnings_date === todayEt, so the earliest eligible
// capture is the NEXT session (earnings_date < todayEt). Deliberately
// NOT a blanket "exclude earnings_date === today" filter — that would
// also break same-day BMO capture, which must keep working. Exported
// standalone (not inlined in runT1Capture) so it's directly testable
// against known cases without needing a live Schwab connection or DB.
export function isT1SessionEligible(
  row: { earnings_date: string; timing: string | null },
  todayEt: string,
): boolean {
  const timing = (row.timing ?? "unknown").toLowerCase();
  if (timing === "bmo") return row.earnings_date <= todayEt;
  return row.earnings_date < todayEt;
}

export type T0Candidate = { symbol: string; earnings_date: string; timing: "amc" | "bmo" | "unknown" };

// Pure selection — no Schwab calls, safe to call from anywhere (including
// a local read-only chain-detail capture) without burning API budget.
// Extracted from runT0Capture so there's one definition, not two that
// can drift; runT0Capture calls this directly.
export async function selectT0Candidates(): Promise<T0Candidate[]> {
  const todayEt = todayEasternIso();
  const tomorrowEt = addDaysIso(todayEt, 1);
  const byKey = new Map<string, T0Candidate>();

  // Source 1: live earnings calendar ∩ app-known symbols. Carries real
  // AMC/BMO timing straight from Finnhub.
  const [{ relevant }, calendar] = await Promise.all([
    buildMaintenanceSymbolSets(),
    getTodayEarnings().catch(() => []),
  ]);
  for (const e of calendar) {
    const sym = e.symbol.toUpperCase();
    if (!relevant.has(sym)) continue;
    const timing: "amc" | "bmo" | "unknown" = e.timing === "AMC" ? "amc" : e.timing === "BMO" ? "bmo" : "unknown";
    byKey.set(`${sym}|${e.date}`, { symbol: sym, earnings_date: e.date, timing });
  }

  // Source 2: pre-ingested earnings_history rows for the window. No real
  // timing available here — "unknown" is deliberately conservative.
  const sb = createServerClient();
  const pre = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,iv_before")
    .gte("earnings_date", todayEt)
    .lte("earnings_date", tomorrowEt)
    .is("iv_before", null);
  for (const r of (pre.data ?? []) as Array<{ symbol: string; earnings_date: string }>) {
    const sym = r.symbol.toUpperCase();
    const key = `${sym}|${r.earnings_date}`;
    if (byKey.has(key)) continue; // Source 1 already has real timing for this pair
    byKey.set(key, { symbol: sym, earnings_date: r.earnings_date, timing: "unknown" });
  }
  return Array.from(byKey.values());
}

export type T1Candidate = {
  symbol: string;
  earnings_date: string;
  iv_before: number | null;
  implied_move_pct: number | null;
  timing: string | null;
};

// Pure selection — no Schwab calls. Extracted from runT1Capture for the
// same reason as selectT0Candidates.
export async function selectT1Candidates(): Promise<T1Candidate[]> {
  const todayEt = todayEasternIso();
  const sb = createServerClient();
  const raw = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,iv_before,implied_move_pct,timing")
    .gte("earnings_date", addDaysIso(todayEt, -4))
    .lte("earnings_date", todayEt)
    .is("iv_after", null);
  if (raw.error) return [];
  return ((raw.data ?? []) as T1Candidate[])
    .filter((r) => r.iv_before !== null && r.implied_move_pct !== null)
    .filter((r) => isT1SessionEligible(r, todayEt));
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
    return { ...report, ok: false, skipReason: "schwab_disconnected" };
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
      report.skipped.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        captured: false,
        reason: e instanceof Error ? e.message : "threw",
      });
    }
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
// set) and no T1 yet, dated within the last 4 days — the window
// tolerates weekends and a missed cron without ever scanning the
// whole table. Self-pairing: only events we actually T0'd are eligible,
// which is exactly the set a crush number is computable for.
export async function runT1Capture(opts?: {
  dryRun?: boolean;
}): Promise<CaptureReport> {
  const dryRun = opts?.dryRun === true;
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
    return { ...report, ok: false, skipReason: "schwab_disconnected" };
  }

  const candidates = await selectT1Candidates();

  report.candidates = candidates.length;
  const startedAt = Date.now();
  const recalcSymbols = new Set<string>();
  for (const c of candidates) {
    if (Date.now() - startedAt > CAPTURE_BUDGET_MS) {
      report.budget_exhausted = true;
      console.warn(
        `[earnings-capture:T1] budget exhausted with ${report.captured.length}/${candidates.length} captured — rest defers to tomorrow's run (4-day window)`,
      );
      break;
    }
    try {
      const r = await captureEarningsT1(c.symbol, c.earnings_date, { dryRun });
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
      report.skipped.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        captured: false,
        reason: e instanceof Error ? e.message : "threw",
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
  }
  return report;
}
