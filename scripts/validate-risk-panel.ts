// Validates the Risk panel (app/api/intelligence/route.ts `risk` block)
// against real data, independent of the running server.
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

type Row = {
  id: string;
  symbol: string;
  strike: string;
  total_contracts: number;
  opened_date: string | null;
  closed_date: string | null;
  realized_pnl: string | null;
  status: string;
  position_type: string | null;
  campaign_id: string | null;
  trade_chain_id: string | null;
};

function campaignKey(p: { campaign_id: string | null; trade_chain_id: string | null; id: string }): string {
  return p.campaign_id ?? p.trade_chain_id ?? `solo:${p.id}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type RiskLeg = { opened_date: string; closed_date: string | null; strike: number; total_contracts: number };

function buildDailyCollateralSeries(legs: RiskLeg[], fromDate: string, toDate: string) {
  const deltas = new Map<string, number>();
  for (const leg of legs) {
    const capital = leg.strike * leg.total_contracts * 100;
    if (!Number.isFinite(capital) || capital <= 0) continue;
    const legEnd = leg.closed_date ?? toDate;
    if (leg.opened_date > toDate || legEnd < fromDate) continue;
    const start = leg.opened_date < fromDate ? fromDate : leg.opened_date;
    const cappedEnd = legEnd > toDate ? toDate : legEnd;
    const endExclusive = addDaysIso(cappedEnd, 1);
    deltas.set(start, (deltas.get(start) ?? 0) + capital);
    deltas.set(endExclusive, (deltas.get(endExclusive) ?? 0) - capital);
  }
  const sortedDeltaDates = Array.from(deltas.keys()).sort();
  const series: Array<{ date: string; collateral: number }> = [];
  let running = 0;
  let di = 0;
  for (let d = fromDate; d <= toDate; d = addDaysIso(d, 1)) {
    while (di < sortedDeltaDates.length && sortedDeltaDates[di] <= d) {
      running += deltas.get(sortedDeltaDates[di]) ?? 0;
      di++;
    }
    series.push({ date: d, collateral: Math.round(running) });
  }
  return series;
}

function peakCampaignCapital(legs: RiskLeg[]): number {
  const deltas = new Map<string, number>();
  for (const leg of legs) {
    const capital = leg.strike * leg.total_contracts * 100;
    if (!Number.isFinite(capital) || capital <= 0) continue;
    const start = leg.opened_date;
    const endExclusive = leg.closed_date ? addDaysIso(leg.closed_date, 1) : start;
    deltas.set(start, (deltas.get(start) ?? 0) + capital);
    deltas.set(endExclusive, (deltas.get(endExclusive) ?? 0) - capital);
  }
  const dates = Array.from(deltas.keys()).sort();
  let running = 0;
  let peak = 0;
  for (const d of dates) {
    running += deltas.get(d) ?? 0;
    if (running > peak) peak = running;
  }
  return peak;
}

const HISTOGRAM_BUCKETS = ["< -$2k", "-$2k to -$500", "-$500 to $0", "$0 to $500", "$500 to $2k", "> $2k"];
function histogramBucketIndex(pnl: number): number {
  if (pnl < -2000) return 0;
  if (pnl < -500) return 1;
  if (pnl < 0) return 2;
  if (pnl < 500) return 3;
  if (pnl < 2000) return 4;
  return 5;
}

async function runWindow(
  sb: ReturnType<typeof import("../lib/supabase")["createServerClient"]>,
  userId: string,
  label: string,
  from: string,
  to: string,
) {
  const closedRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,total_contracts,opened_date,closed_date,realized_pnl,status,position_type,campaign_id,trade_chain_id",
    )
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const allClosedRaw = (closedRes.data ?? []) as Row[];
  const allClosed = allClosedRaw.filter((p) => p.position_type !== "stock_long" && p.position_type !== "stock_short");

  const openRes = await sb
    .from("positions")
    .select("id,symbol,strike,total_contracts,opened_date,closed_date,position_type,campaign_id,trade_chain_id")
    .eq("user_id", userId)
    .eq("status", "open");
  const openRows = (openRes.data ?? []) as Row[];
  const openOptions = openRows.filter((p) => p.position_type !== "stock_long" && p.position_type !== "stock_short");
  const openKeys = new Set(openRows.map((p) => campaignKey(p)));

  // Collateral legs: all option legs, any status, missing-date check.
  let legsMissingDates = 0;
  const legs: RiskLeg[] = [];
  for (const p of allClosed) {
    if (!p.opened_date || p.closed_date === null) {
      legsMissingDates++;
      continue;
    }
    legs.push({ opened_date: p.opened_date, closed_date: p.closed_date, strike: Number(p.strike), total_contracts: Number(p.total_contracts) });
  }
  for (const p of openOptions) {
    if (!p.opened_date) {
      legsMissingDates++;
      continue;
    }
    legs.push({ opened_date: p.opened_date, closed_date: null, strike: Number(p.strike), total_contracts: Number(p.total_contracts) });
  }

  const series = buildDailyCollateralSeries(legs, from, to);
  let peak = 0;
  let peakDate: string | null = null;
  let sum = 0;
  for (const pt of series) {
    sum += pt.collateral;
    if (pt.collateral > peak) {
      peak = pt.collateral;
      peakDate = pt.date;
    }
  }
  const avgDeployed = series.length > 0 ? sum / series.length : 0;
  const avgPctOfPeak = peak > 0 ? avgDeployed / peak : null;

  // Row-level period realized (option + stock, closed_date in window) — matches combined_realized_pnl.
  const windowedAll = allClosedRaw.filter((p) => (p.closed_date ?? "") >= from && (p.closed_date ?? "") <= to);
  const periodRealized = Math.round(windowedAll.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) * 100) / 100;
  const returnOnPeak = peak > 0 ? periodRealized / peak : null;

  // Campaign map (all-time net + terminal/first close dates + option legs) for windowedCampaigns.
  type CAgg = { symbol: string; netPnl: number; firstCloseDate: string; terminalDate: string; optionLegs: RiskLeg[] };
  const campaignMap = new Map<string, CAgg>();
  for (const p of allClosedRaw) {
    const key = campaignKey(p);
    const cd = p.closed_date ?? "";
    let agg = campaignMap.get(key);
    if (!agg) {
      agg = { symbol: p.symbol, netPnl: 0, firstCloseDate: cd, terminalDate: cd, optionLegs: [] };
      campaignMap.set(key, agg);
    }
    agg.netPnl += Number(p.realized_pnl ?? 0);
    if (cd > agg.terminalDate) agg.terminalDate = cd;
    if (cd < agg.firstCloseDate) agg.firstCloseDate = cd;
    if (p.position_type !== "stock_long" && p.position_type !== "stock_short" && p.opened_date) {
      agg.optionLegs.push({ opened_date: p.opened_date, closed_date: p.closed_date, strike: Number(p.strike), total_contracts: Number(p.total_contracts) });
    }
  }
  const resolvedCampaigns = Array.from(campaignMap.entries()).filter(([key]) => !openKeys.has(key));
  const windowedCampaigns = resolvedCampaigns.filter(([, c]) => c.terminalDate >= from && c.terminalDate <= to).map(([, c]) => c);

  let worst: { symbol: string; pnl: number } | null = null;
  for (const c of windowedCampaigns) {
    if (!worst || c.netPnl < worst.pnl) worst = { symbol: c.symbol, pnl: Math.round(c.netPnl * 100) / 100 };
  }
  const worstLoss = worst && worst.pnl < 0 ? worst : null;
  const winPnls = windowedCampaigns.filter((c) => c.netPnl > 0).map((c) => c.netPnl).sort((a, b) => a - b);
  const medianWin = winPnls.length === 0 ? null : winPnls.length % 2 === 1 ? winPnls[(winPnls.length - 1) / 2] : (winPnls[winPnls.length / 2 - 1] + winPnls[winPnls.length / 2]) / 2;
  const ratio = worstLoss && medianWin && medianWin > 0 ? Math.abs(worstLoss.pnl) / medianWin : null;

  const buckets = HISTOGRAM_BUCKETS.map((label) => ({ label, count: 0, symbols: new Set<string>() }));
  for (const c of windowedCampaigns) {
    const idx = histogramBucketIndex(c.netPnl);
    buckets[idx].count++;
    buckets[idx].symbols.add(c.symbol);
  }

  console.log(`\n=== ${label} (${from}..${to}) ===`);
  console.log(`Peak collateral: $${peak.toLocaleString()} on ${peakDate}`);
  console.log(`Avg deployed: $${Math.round(avgDeployed).toLocaleString()} (${avgPctOfPeak !== null ? (avgPctOfPeak * 100).toFixed(1) + "%" : "—"} of peak)`);
  console.log(`Return on peak: ${returnOnPeak !== null ? (returnOnPeak * 100).toFixed(2) + "%" : "—"} (realized $${periodRealized.toLocaleString()} / peak $${peak.toLocaleString()})`);
  console.log(`Worst loss: ${worstLoss ? `${worstLoss.symbol} $${worstLoss.pnl}` : "none"}  |  median win: ${medianWin !== null ? "$" + medianWin.toFixed(2) : "—"}  |  ratio: ${ratio !== null ? ratio.toFixed(2) + "x" : "—"}`);
  console.log(`legsMissingDates: ${legsMissingDates}`);
  console.log(`windowedCampaigns count: ${windowedCampaigns.length}`);
  console.log(`Histogram:`);
  for (const b of buckets) {
    console.log(`  ${b.label.padEnd(16)} count=${b.count}  symbols=${Array.from(b.symbols).join(",")}`);
  }
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  await runWindow(sb, userId, "Q3 2026", "2026-07-01", "2026-09-30");
  await runWindow(sb, userId, "All-time", "2020-01-01", "2026-08-13");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
