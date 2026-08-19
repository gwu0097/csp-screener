// Re-derives earnings_history.price_before/price_after (and the fields
// that mechanically depend on them) from earnings_price_paths, for
// rows flagged by either of two independent diagnostics run earlier in
// this thread:
//   - the "unverifiable" set from backfill-earnings-timing-report.json
//     (264 rows: stored prices didn't match a BMO or AMC reconstruction)
//   - the implausibly-small-move sweep (|actual_move_pct| < 0.5%)
//
// Scope, deliberately narrow:
//   - data_source IN ('unknown_legacy_write', 'encyclopedia_phase1_finnhub',
//     'encyclopedia_phase2c_rekey') only. The old literals this scope was
//     originally written against ('finnhub', 'finnhub+calendar-rekey')
//     were retired by the earnings_history provenance migration — the
//     migration's own backfill mapped rows written under those old
//     values into unknown_legacy_write (confirmed live: 'encyclopedia-
//     live' rows got their own distinct encyclopedia_live_stub bucket,
//     so unknown_legacy_write is cleanly NOT that path), and
//     encyclopedia_phase1_finnhub/encyclopedia_phase2c_rekey are the
//     same two ingest paths' go-forward literals. encyclopedia-live
//     rows (now encyclopedia_live_stub, or later t0_capture-touched)
//     use live intraday Schwab quotes at T0/T1 — a different, correct
//     data source; touching them would be a downgrade, not a repair —
//     still excluded, unchanged from the original intent.
//   - timing IN ('bmo','amc') only. Rows with no assigned timing have
//     no basis to pick trading-day offsets from; left untouched.
//
// No circularity to break: verified against the actual backfill code
// (scripts/backfill-earnings-timing.ts lines ~141/185) that `timing`
// is ALWAYS written as the Yahoo-calendar-derived heuristicHour, never
// the price-implied value — the price comparison there only gated
// whether to write, never what to write. So the assigned timing is a
// safe, independent basis for picking offsets here.
//
// earnings_price_paths anchors offset=0 to "first trading day on/after
// earnings_date" and indexes by array position (see
// scripts/backfill-earnings-price-paths.ts) — immune to the calendar-
// arithmetic weekend-date bug fixed separately in
// lib/encyclopedia.ts's fetchYahooPriceActionTimed.
//
// Usage: npx tsx scripts/repair-earnings-history-prices.ts [--dry]
import { readFileSync, writeFileSync } from "node:fs";
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

// Data-driven, not guessed: the full earnings_price_paths dataset's
// one-trading-day-return distribution around offsets -1/0/+1 has
// max=40.40%, p99.9=36.48% (n=5,178 — computed live against this DB
// before writing this script). 50% sits comfortably above the largest
// genuine single-day earnings reaction ever observed here, while still
// catching CVNA-style corruption (~5x/400%+ divergence) cleanly.
const WILD_DIVERGENCE_THRESHOLD = 0.5;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextFridayOnOrAfterIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  const delta = (5 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

type EhRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  price_before: number | null;
  price_after: number | null;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  timing: "bmo" | "amc";
  timing_source: string | null;
  data_source: string;
};

type PathRow = { trading_day_offset: number; trade_date: string; close: number };

function relDiff(a: number, b: number): number {
  return Math.abs(a / b - 1);
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { calculateBreachAnalysis } = await import("../lib/encyclopedia");

  const dryRun = process.argv.includes("--dry");
  const sb = createServerClient();

  const report = JSON.parse(
    readFileSync(resolve(process.cwd(), "backfill-earnings-timing-report.json"), "utf8"),
  ) as { unverifiable: Array<{ symbol: string; earnings_date: string }>; inconsistent: Array<{ symbol: string; earnings_date: string }> };
  const flaggedPairs = [...report.unverifiable, ...report.inconsistent];

  // Cursor-paginate to bypass the ~1000-row read cap, filtering to the
  // scope in JS (the "flagged by either signature" condition mixes a
  // computed set with a SQL predicate — simplest to fetch the narrower
  // SQL-expressible superset then intersect here).
  type Candidate = EhRow;
  const allInScope: Candidate[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const res = await sb
      .from("earnings_history")
      .select(
        "id,symbol,earnings_date,price_before,price_after,actual_move_pct,implied_move_pct,timing,timing_source,data_source",
      )
      .in("data_source", ["unknown_legacy_write", "encyclopedia_phase1_finnhub", "encyclopedia_phase2c_rekey"])
      .in("timing", ["bmo", "amc"])
      .order("id", { ascending: true })
      .gt("id", lastId)
      .limit(1000);
    const batch = (res.data ?? []) as Candidate[];
    if (batch.length === 0) break;
    allInScope.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }

  const flaggedSet = new Set(flaggedPairs.map((p) => `${p.symbol}|${p.earnings_date}`));
  const candidates = allInScope.filter(
    (r) =>
      (r.actual_move_pct !== null && Math.abs(r.actual_move_pct) < 0.005) ||
      flaggedSet.has(`${r.symbol}|${r.earnings_date}`),
  );
  console.log(`[${new Date().toISOString()}] repair candidates: ${candidates.length}${dryRun ? " [dry run]" : ""}`);

  // Back up every candidate BEFORE any write, regardless of what
  // bucket it ends up in — simplest correct rule, and cheap (113 rows).
  if (!dryRun && candidates.length > 0) {
    const ids = candidates.map((c) => c.id);
    const backupRes = await sb
      .from("earnings_history")
      .select("*")
      .in("id", ids);
    const fullRows = backupRes.data ?? [];
    const insertRes = await sb.from("backup_20260805_earnings_history_price_repair").insert(fullRows);
    if (insertRes.error) {
      console.error("BACKUP FAILED — aborting, no writes will happen:", insertRes.error.message);
      process.exit(1);
    }
    console.log(`backed up ${fullRows.length} rows to backup_20260805_earnings_history_price_repair`);
  }

  let repaired = 0;
  let excludedWildDivergence = 0;
  let excludedNoCoverage = 0;
  const timingFlags: Array<{ symbol: string; earnings_date: string; assigned: string; assignedMove: number; alternateMove: number }> = [];
  const wildDivergenceDetail: Array<{ symbol: string; earnings_date: string; stored_price_before: number | null; rederived_price_before: number | null }> = [];
  const moveDeltas: Array<{ symbol: string; earnings_date: string; old_move: number | null; new_move: number }> = [];
  const writeFailures: Array<{ symbol: string; earnings_date: string; error: string }> = [];

  for (const row of candidates) {
    const pathsRes = await sb
      .from("earnings_price_paths")
      .select("trading_day_offset,trade_date,close")
      .eq("symbol", row.symbol)
      .eq("earnings_date", row.earnings_date);
    const paths = ((pathsRes.data ?? []) as PathRow[]).sort((a, b) => a.trading_day_offset - b.trading_day_offset);
    const byOffset = new Map(paths.map((p) => [p.trading_day_offset, Number(p.close)]));

    const bmoBefore = byOffset.get(-1) ?? null;
    const bmoAfter = byOffset.get(0) ?? null;
    const amcBefore = byOffset.get(0) ?? null;
    const amcAfter = byOffset.get(1) ?? null;

    const assignedBefore = row.timing === "bmo" ? bmoBefore : amcBefore;
    const assignedAfter = row.timing === "bmo" ? bmoAfter : amcAfter;
    const alternateBefore = row.timing === "bmo" ? amcBefore : bmoBefore;
    const alternateAfter = row.timing === "bmo" ? amcAfter : bmoAfter;

    if (assignedBefore === null || assignedAfter === null) {
      excludedNoCoverage += 1;
      if (!dryRun) {
        await sb.from("earnings_history").update({ price_repair_status: "excluded_no_coverage" }).eq("id", row.id);
      }
      continue;
    }

    // Informational only — does NOT gate the write. A row whose
    // assigned-timing move looks flat while the alternate shows a real
    // move is a signal the ASSIGNED TIMING might be wrong, not a
    // reason to silently flip which offsets get used. Threshold picked
    // by inspecting the actual distribution for this candidate set
    // (dry run): assigned moves are all <1.5% by construction (this
    // population is flagged FOR being small/unverifiable), and the
    // alternate-move distribution has a natural qualitative break
    // around 2% — below it looks like normal noise around a quiet
    // quarter (e.g. COST -0.00%/1.15%), above it looks like a real,
    // clearly-missed reaction (e.g. CFG -0.19%/-6.40%).
    if (alternateBefore !== null && alternateAfter !== null && alternateBefore > 0) {
      const assignedMove = (assignedAfter - assignedBefore) / assignedBefore;
      const alternateMove = (alternateAfter - alternateBefore) / alternateBefore;
      const alternateDominates = Math.abs(alternateMove) >= 0.02;
      if (alternateDominates) {
        timingFlags.push({
          symbol: row.symbol,
          earnings_date: row.earnings_date,
          assigned: row.timing,
          assignedMove,
          alternateMove,
        });
      }
    }

    const oldBefore = row.price_before;
    const oldAfter = row.price_after;
    const wildBefore = oldBefore !== null && oldBefore > 0 && relDiff(assignedBefore, oldBefore) > WILD_DIVERGENCE_THRESHOLD;
    const wildAfter = oldAfter !== null && oldAfter > 0 && relDiff(assignedAfter, oldAfter) > WILD_DIVERGENCE_THRESHOLD;
    if (wildBefore || wildAfter) {
      excludedWildDivergence += 1;
      wildDivergenceDetail.push({
        symbol: row.symbol,
        earnings_date: row.earnings_date,
        stored_price_before: oldBefore,
        rederived_price_before: assignedBefore,
      });
      if (!dryRun) {
        await sb.from("earnings_history").update({ price_repair_status: "excluded_wild_divergence" }).eq("id", row.id);
      }
      continue;
    }

    const newActualMovePct = (assignedAfter - assignedBefore) / assignedBefore;
    const expiryTarget = nextFridayOnOrAfterIso(addDaysIso(row.earnings_date, 1));
    let newPriceAtExpiry: number | null = null;
    for (const p of paths) {
      if (p.trade_date <= expiryTarget) newPriceAtExpiry = Number(p.close);
      else break;
    }

    const breach = calculateBreachAnalysis({
      price_before: assignedBefore,
      price_after: assignedAfter,
      price_at_expiry: newPriceAtExpiry,
      implied_move_pct: row.implied_move_pct,
      actual_move_pct: newActualMovePct,
    });

    moveDeltas.push({
      symbol: row.symbol,
      earnings_date: row.earnings_date,
      old_move: row.actual_move_pct,
      new_move: newActualMovePct,
    });

    if (!dryRun) {
      const up = await sb
        .from("earnings_history")
        .update({
          price_before: assignedBefore,
          price_after: assignedAfter,
          actual_move_pct: newActualMovePct,
          price_at_expiry: newPriceAtExpiry,
          move_ratio: breach.move_ratio,
          two_x_em_strike: breach.two_x_em_strike,
          breached_two_x_em: breach.breached_two_x_em,
          recovered_by_expiry: breach.recovered_by_expiry,
          price_repair_status: "repaired",
        })
        .eq("id", row.id);
      if (up.error) {
        writeFailures.push({ symbol: row.symbol, earnings_date: row.earnings_date, error: up.error.message });
        continue;
      }
    }
    repaired += 1;
  }

  const out = {
    dryRun,
    candidates: candidates.length,
    repaired,
    excludedWildDivergence,
    excludedNoCoverage,
    writeFailuresCount: writeFailures.length,
    writeFailures,
    timingFlagsCount: timingFlags.length,
    timingFlags,
    wildDivergenceDetail,
    moveDeltas,
  };
  console.log("\n==== repair-earnings-history-prices report ====");
  console.log(
    JSON.stringify(
      { ...out, timingFlags: undefined, wildDivergenceDetail: undefined, moveDeltas: undefined },
      null,
      2,
    ),
  );
  writeFileSync(resolve(process.cwd(), "repair-earnings-history-prices-report.json"), JSON.stringify(out, null, 2));
  console.log("\nfull report: repair-earnings-history-prices-report.json");
}
main().catch((e) => {
  console.error("[repair-earnings-history-prices] fatal:", e);
  process.exit(1);
});
