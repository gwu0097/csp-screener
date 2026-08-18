// Daily post-earnings full-chain IV capture. Runs LOCALLY (launchd,
// com.csp.post-earnings-capture) — never through Vercel, since the
// 60s maxDuration ceiling makes a 445-symbol peak day impossible
// there (Schwab's 120 req/min alone requires ≥3.7 minutes minimum).
// Talks to Schwab and Supabase directly; writes chain data to local
// Parquet (lib/local-chain-store.ts) — Supabase keeps only what the
// web app needs (earnings_history, positions, fills, screener
// tables), not this capture's raw output.
//
// Scope: every earnings_history row with date_confidence != 'inferred'
// (was date_confidence='confirmed' before the 2026-08-19 provenance
// migration retired that value — 'confirmed' was always just "nothing
// downgraded it," the column's silent default, not real evidence;
// excluding only 'inferred', the successor to the old 'low', reproduces
// the same row set the 'confirmed' filter always actually meant)
// whose T+1..T+20 trading-day window (business days, no holiday
// calendar) includes today. Full chain per symbol — strikeCount=200,
// contractType=ALL, no date bound, no strike filtering — the window
// decision was dropped once local storage size stopped being a
// constraint (~746MB/year at this scope, confirmed acceptable).
//
// Candidate selection and the actual capture loop are both this
// script's own job here — the loop itself is shared with the T0/T1
// companion via lib/chain-capture-core.ts (one writer, one
// throttle/chunk/outcome-logging implementation, no drift between
// the two entry points).
//
// Usage: npx tsx scripts/capture-post-earnings-chain.ts [--symbol SYM --date YYYY-MM-DD] [--dry]
//   [--skip-reconcile] (used by the same-day retry-pass launchd trigger,
//     so reconciliation only runs once per day off the main trigger)
//   [--simulate-transient SYM:N] (test hook — first N attempts for SYM
//     fail with a synthetic 429, proving the retry path fires)
//   [--simulate-missed-date YYYY-MM-DD] (test hook — runs reconciliation
//     anchored so its lookback window includes this date, then exits;
//     does not run a live capture)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

function isBday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}
function addBdays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let remaining = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (isBday(d)) remaining -= 1;
  }
  return d.toISOString().slice(0, 10);
}
function bdayOffset(anchor: string, target: string): number {
  if (target === anchor) return 0;
  const forward = target > anchor;
  let cur = anchor;
  let offset = 0;
  while (cur !== target) {
    cur = addBdays(cur, forward ? 1 : -1);
    offset += forward ? 1 : -1;
    if (Math.abs(offset) > 40) return NaN;
  }
  return offset;
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { runChainCapture } = await import("../lib/chain-capture-core");
  const { todayEasternIso } = await import("../lib/earnings-capture");
  const { reconcileMissedCaptures } = await import("../lib/capture-reconciliation");
  const { SchwabApiError } = await import("../lib/schwab");

  const dryRun = process.argv.includes("--dry");
  const skipReconcile = process.argv.includes("--skip-reconcile");
  const symArgIdx = process.argv.indexOf("--symbol");
  const dateArgIdx = process.argv.indexOf("--date");
  const overrideSymbol = symArgIdx !== -1 ? process.argv[symArgIdx + 1]?.toUpperCase() : null;
  const overrideDate = dateArgIdx !== -1 ? process.argv[dateArgIdx + 1] : null;

  const simTransientIdx = process.argv.indexOf("--simulate-transient");
  let simTransientSymbol: string | null = null;
  let simTransientCount = 0;
  if (simTransientIdx !== -1) {
    const [sym, n] = (process.argv[simTransientIdx + 1] ?? "").split(":");
    simTransientSymbol = sym?.toUpperCase() ?? null;
    simTransientCount = Number(n) || 0;
  }

  const simMissedIdx = process.argv.indexOf("--simulate-missed-date");
  const simMissedDate = simMissedIdx !== -1 ? process.argv[simMissedIdx + 1] : null;
  if (simMissedDate) {
    const anchor = addBdays(simMissedDate, 1);
    console.log(`[simulate-missed-date] reconciling with anchor=${anchor} so lookback includes ${simMissedDate}`);
    const report = await reconcileMissedCaptures(anchor, { lookbackDays: 3 });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const captureDate = todayEasternIso();
  console.log(`[${new Date().toISOString()}] post-earnings chain capture — captureDate=${captureDate}${dryRun ? " [dry run]" : ""}`);

  if (!skipReconcile && !overrideSymbol) {
    console.log("running reconciliation pass...");
    const report = await reconcileMissedCaptures(captureDate);
    console.log(`reconciliation: checked=${report.checkedDates.length} neverFired=${report.neverFiredDates.length} ` +
      `partial=${report.partialDates.length} missedRowsWritten=${report.missedRowsWritten}`);
    if (report.neverFiredDates.length > 0) console.log(`  never fired: ${report.neverFiredDates.join(", ")}`);
    if (report.partialDates.length > 0) console.log(`  partial (had outstanding): ${report.partialDates.join(", ")}`);
  }

  const sb = createServerClient();
  type Candidate = {
    symbol: string;
    earnings_date: string;
    earnings_history_id: string | null;
    trading_day_offset: number | null;
  };
  let due: Candidate[];

  if (overrideSymbol && overrideDate) {
    const evRes = await sb
      .from("earnings_history")
      .select("id")
      .eq("symbol", overrideSymbol)
      .eq("earnings_date", overrideDate)
      .maybeSingle();
    due = [
      {
        symbol: overrideSymbol,
        earnings_date: overrideDate,
        earnings_history_id: (evRes.data as { id: string } | null)?.id ?? null,
        trading_day_offset: bdayOffset(overrideDate, captureDate),
      },
    ];
    console.log(`override mode: forcing ${overrideSymbol}@${overrideDate}, offset=${due[0].trading_day_offset}`);
  } else {
    const lowerBound = addBdays(captureDate, -30);
    const raw = await sb
      .from("earnings_history")
      .select("id,symbol,earnings_date")
      // See the header comment's provenance-migration note.
      .neq("date_confidence", "inferred")
      .gte("earnings_date", lowerBound)
      .lte("earnings_date", captureDate);
    const rows = (raw.data ?? []) as Array<{ id: string; symbol: string; earnings_date: string }>;
    due = [];
    for (const r of rows) {
      const offset = bdayOffset(r.earnings_date, captureDate);
      if (offset >= 1 && offset <= 20) {
        due.push({
          symbol: r.symbol.toUpperCase(),
          earnings_date: r.earnings_date,
          earnings_history_id: r.id,
          trading_day_offset: offset,
        });
      }
    }
  }

  console.log(`due candidates: ${due.length}`);
  const faultInjector =
    simTransientSymbol && simTransientCount > 0
      ? (symbol: string, attempt: number) => {
          if (symbol !== simTransientSymbol || attempt > simTransientCount) return null;
          console.log(`[simulate-transient] injecting synthetic 429 for ${symbol} attempt ${attempt}/${simTransientCount}`);
          return new SchwabApiError(429, `Schwab GET /marketdata/v1/chains failed: 429 {"error":"simulated rate limit"}`);
        }
      : undefined;
  const result = await runChainCapture(due, "daily", captureDate, {
    dryRun,
    alertLabel: "Post-earnings",
    faultInjector,
  });
  console.log(
    `\n==== post-earnings chain capture done ====\n` +
      `due=${result.due} attempted=${result.attempted} alreadyDoneToday=${result.alreadyDoneToday} ` +
      `fired=${result.fired} errored=${result.errored} disconnected=${result.disconnected} suppressed=${result.suppressed} ` +
      `totalStrikes=${result.totalStrikes} aborted=${result.aborted ?? "no"}`,
  );
}

main().catch((e) => {
  console.error("[capture-post-earnings-chain] fatal:", e);
  process.exit(1);
});
