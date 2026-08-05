// Weekly, read-only scan for the report-window-gap price corruption
// signature: an earnings_history row whose price_before/price_after
// exactly match real Yahoo daily closes on a chronologically-ordered,
// adjacent-day pair (before-date < after-date, <=5 calendar days
// apart) that lands more than ~10 days from the row's own
// earnings_date. That's the exact shape of the bug fixed in
// lib/encyclopedia.ts's fetchYahooPriceAction on 2026-08-05 (isQuarterEndDate
// gate) — this scan exists because that fix only closes the mechanisms
// found; it can't rule out an unknown writer doing the same thing.
//
// isQuarterEndDate rows are excluded: for those, a match weeks out is
// the *intended* behavior (the date is a legacy fiscal quarter-end
// marker, not a real announcement date), not corruption.
//
// WARN ONLY. Never writes to earnings_history. Findings are upserted
// into price_integrity_flags (see migrations/2026-08-05-add-price-
// integrity-flags.sql) for the capture-health panel to surface —
// repair stays a deliberate, backed-up, reviewed action, not something
// a cron does unattended.
//
// Piggybacks on the existing weekly com.csp.schwab-health cron (see
// ~/bin/csp-schwab-health.sh) rather than a new launchd agent.
//
// Two correctness requirements from this exact investigation, kept
// explicit so a future edit doesn't silently reintroduce either bug:
//   1. Cursor-paginate past the ~1000-row Supabase-wrapper read cap —
//      an earlier ad-hoc scan silently truncated to 202 symbols when
//      the table actually held 571.
//   2. Require the matched "before" date to chronologically precede
//      the matched "after" date — an earlier pass flagged HST as a
//      false positive by matching each leg independently without
//      checking order, picking up an unrelated coincidental match.
//
// Usage: npx tsx scripts/detect-price-date-mismatch.ts [--dry]
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

const EXACT_MATCH_EPSILON = 1e-6;
const MAX_ADJACENT_LEG_GAP_DAYS = 5;
const MIN_SUSPICIOUS_GAP_DAYS = 10;

type EhRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  price_before: number | null;
  price_after: number | null;
  actual_move_pct: number | null;
};

type Bar = { iso: string; close: number };

type Flag = {
  symbol: string;
  earnings_date: string;
  stored_price_before: number;
  stored_price_after: number;
  stored_actual_move_pct: number | null;
  matched_before_date: string;
  matched_after_date: string;
  gap_from_earnings_days: number;
};

function daysBetween(aIso: string, bIso: string): number {
  return Math.round(
    (new Date(bIso + "T00:00:00Z").getTime() - new Date(aIso + "T00:00:00Z").getTime()) / 86_400_000,
  );
}

async function fetchAllRows(): Promise<EhRow[]> {
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();
  const all: EhRow[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const res = await sb
      .from("earnings_history")
      .select("id,symbol,earnings_date,price_before,price_after,actual_move_pct")
      .order("id", { ascending: true })
      .gt("id", lastId)
      .limit(1000);
    if (res.error) throw new Error(`read failed: ${res.error.message}`);
    const batch = (res.data ?? []) as EhRow[];
    if (batch.length === 0) break;
    all.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }
  return all;
}

// Finds a chronologically valid before->after pair (both legs exact
// matches, before < after, <=MAX_ADJACENT_LEG_GAP_DAYS apart) whose
// distance from earnings_date exceeds MIN_SUSPICIOUS_GAP_DAYS. Prefers
// the pair with the largest such gap when more than one exists.
function findSuspiciousPair(
  row: EhRow,
  sortedBars: Bar[],
): { beforeIso: string; afterIso: string; gapDays: number } | null {
  const exactMatches = (target: number): Bar[] =>
    sortedBars.filter((b) => Math.abs(b.close - target) < EXACT_MATCH_EPSILON);
  const beforeHits = exactMatches(row.price_before!);
  const afterHits = exactMatches(row.price_after!);
  if (beforeHits.length === 0 || afterHits.length === 0) return null;

  let best: { beforeIso: string; afterIso: string; gapDays: number } | null = null;
  for (const bh of beforeHits) {
    for (const ah of afterHits) {
      const legGap = daysBetween(bh.iso, ah.iso);
      if (legGap <= 0 || legGap > MAX_ADJACENT_LEG_GAP_DAYS) continue; // enforces before < after
      const gapFromEarnings = Math.min(
        Math.abs(daysBetween(row.earnings_date, bh.iso)),
        Math.abs(daysBetween(row.earnings_date, ah.iso)),
      );
      if (gapFromEarnings > MIN_SUSPICIOUS_GAP_DAYS && (!best || gapFromEarnings > best.gapDays)) {
        best = { beforeIso: bh.iso, afterIso: ah.iso, gapDays: gapFromEarnings };
      }
    }
  }
  return best;
}

async function main() {
  loadEnvLocal();
  const dryRun = process.argv.includes("--dry");
  const { createServerClient } = await import("../lib/supabase");
  const { getHistoricalPrices } = await import("../lib/yahoo");
  const { isQuarterEndDate } = await import("../lib/encyclopedia");
  const sb = createServerClient();

  const allRows = await fetchAllRows();
  console.log(`[detect-price-date-mismatch] fetched ${allRows.length} earnings_history rows`);

  const candidates = allRows.filter(
    (r) => r.price_before !== null && r.price_after !== null && !isQuarterEndDate(r.earnings_date),
  );
  console.log(`  candidates (both prices present, not a quarter-end marker) = ${candidates.length}`);

  const bySymbol = new Map<string, EhRow[]>();
  for (const r of candidates) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r);
  }
  console.log(`  distinct symbols = ${bySymbol.size}`);

  const flags: Flag[] = [];
  let symIdx = 0;
  for (const [symbol, rows] of Array.from(bySymbol.entries())) {
    symIdx += 1;
    if (symIdx % 50 === 0) console.log(`  ... ${symIdx}/${bySymbol.size} symbols scanned, ${flags.length} flagged so far`);
    const dates = rows.map((r) => new Date(r.earnings_date).getTime());
    const from = new Date(Math.min(...dates) - 60 * 86_400_000);
    const to = new Date(Math.max(...dates) + 60 * 86_400_000);
    let bars: Array<{ date: unknown; close: unknown }>;
    try {
      bars = await getHistoricalPrices(symbol, from, to);
    } catch (e) {
      console.warn(`  [${symbol}] Yahoo fetch failed, skipping: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const sortedBars: Bar[] = bars
      .map((b) => ({
        iso: (b.date instanceof Date ? b.date.toISOString() : String(b.date)).slice(0, 10),
        close: Number(b.close),
      }))
      .filter((b) => b.iso && Number.isFinite(b.close) && b.close > 0)
      .sort((a, b) => a.iso.localeCompare(b.iso));
    if (sortedBars.length === 0) continue;

    for (const row of rows) {
      const pair = findSuspiciousPair(row, sortedBars);
      if (pair) {
        flags.push({
          symbol,
          earnings_date: row.earnings_date,
          stored_price_before: row.price_before!,
          stored_price_after: row.price_after!,
          stored_actual_move_pct: row.actual_move_pct,
          matched_before_date: pair.beforeIso,
          matched_after_date: pair.afterIso,
          gap_from_earnings_days: pair.gapDays,
        });
      }
    }
  }

  console.log(`\n[detect-price-date-mismatch] ${flags.length} row(s) match the corruption signature`);
  for (const f of flags) {
    console.log(
      `  ${f.symbol} ${f.earnings_date}: stored actual=${f.stored_actual_move_pct} ` +
        `(before=${f.stored_price_before}@${f.matched_before_date}, after=${f.stored_price_after}@${f.matched_after_date}, ` +
        `${f.gap_from_earnings_days}d from earnings_date)`,
    );
  }

  if (dryRun) {
    console.log("\n[dry run] no writes to price_integrity_flags.");
    return;
  }

  // Reconcile against existing unresolved flags: keep detected_at for
  // rows still flagged, insert fresh for new ones, resolve ones that
  // no longer match (repaired since the last run).
  const existingRes = await sb
    .from("price_integrity_flags")
    .select("symbol,earnings_date")
    .is("resolved_at", null);
  const existing = new Set(
    ((existingRes.data ?? []) as Array<{ symbol: string; earnings_date: string }>).map(
      (r) => `${r.symbol}|${r.earnings_date}`,
    ),
  );
  const currentKeys = new Set(flags.map((f) => `${f.symbol}|${f.earnings_date}`));
  const nowIso = new Date().toISOString();

  const toInsert = flags.filter((f) => !existing.has(`${f.symbol}|${f.earnings_date}`));
  const toRefresh = flags.filter((f) => existing.has(`${f.symbol}|${f.earnings_date}`));
  const toResolve = Array.from(existing).filter((k) => !currentKeys.has(k));

  if (toInsert.length > 0) {
    const ins = await sb.from("price_integrity_flags").insert(
      toInsert.map((f) => ({
        symbol: f.symbol,
        earnings_date: f.earnings_date,
        stored_price_before: f.stored_price_before,
        stored_price_after: f.stored_price_after,
        stored_actual_move_pct: f.stored_actual_move_pct,
        matched_before_date: f.matched_before_date,
        matched_after_date: f.matched_after_date,
        gap_from_earnings_days: f.gap_from_earnings_days,
        detected_at: nowIso,
        last_confirmed_at: nowIso,
      })),
    );
    if (ins.error) console.warn(`  insert failed: ${ins.error.message}`);
    else console.log(`  ${toInsert.length} new flag(s) recorded`);
  }

  for (const f of toRefresh) {
    const upd = await sb
      .from("price_integrity_flags")
      .update({
        stored_price_before: f.stored_price_before,
        stored_price_after: f.stored_price_after,
        stored_actual_move_pct: f.stored_actual_move_pct,
        matched_before_date: f.matched_before_date,
        matched_after_date: f.matched_after_date,
        gap_from_earnings_days: f.gap_from_earnings_days,
        last_confirmed_at: nowIso,
      })
      .eq("symbol", f.symbol)
      .eq("earnings_date", f.earnings_date)
      .is("resolved_at", null);
    if (upd.error) console.warn(`  refresh failed for ${f.symbol} ${f.earnings_date}: ${upd.error.message}`);
  }
  if (toRefresh.length > 0) console.log(`  ${toRefresh.length} existing flag(s) refreshed`);

  for (const key of toResolve) {
    const [symbol, earnings_date] = key.split("|");
    const upd = await sb
      .from("price_integrity_flags")
      .update({ resolved_at: nowIso })
      .eq("symbol", symbol)
      .eq("earnings_date", earnings_date)
      .is("resolved_at", null);
    if (upd.error) console.warn(`  resolve failed for ${symbol} ${earnings_date}: ${upd.error.message}`);
  }
  if (toResolve.length > 0) console.log(`  ${toResolve.length} previously-flagged row(s) no longer match — marked resolved`);
}

main().catch((e) => {
  console.error("[detect-price-date-mismatch] fatal:", e);
  process.exit(1);
});
