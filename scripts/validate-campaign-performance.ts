// Validates the campaign-level Performance rebuild in
// app/api/intelligence/route.ts against real data, independent of the
// running Next.js server (auth makes that route hard to curl from a
// script). Re-implements the same grouping/aggregation logic against
// the same tables and reports the same numbers the API would return
// for a given [from, to] window, so discrepancies are visible before
// trusting the live endpoint.
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
  opened_date: string;
  closed_date: string | null;
  realized_pnl: string | null;
  status: string;
  position_type: string | null;
  campaign_id: string | null;
  trade_chain_id: string | null;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function campaignKey(p: { campaign_id: string | null; trade_chain_id: string | null; id: string }): string {
  return p.campaign_id ?? p.trade_chain_id ?? `solo:${p.id}`;
}

function peakCampaignCapital(
  legs: Array<{ opened_date: string; closed_date: string | null; strike: number; total_contracts: number }>,
): number {
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

async function computeWindow(sb: ReturnType<typeof import("../lib/supabase")["createServerClient"]>, userId: string, from: string, to: string) {
  const closedRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,total_contracts,opened_date,closed_date,realized_pnl,status,position_type,campaign_id,trade_chain_id",
    )
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const allClosedRaw = (closedRes.data ?? []) as Row[];

  const openRes = await sb
    .from("positions")
    .select("id,symbol,campaign_id,trade_chain_id")
    .eq("user_id", userId)
    .eq("status", "open");
  const openKeys = new Set(
    ((openRes.data ?? []) as Array<{ id: string; campaign_id: string | null; trade_chain_id: string | null }>).map(
      (p) => campaignKey(p),
    ),
  );

  // Row-level totals (must not move vs the pre-campaign route).
  const windowedOptions = allClosedRaw.filter(
    (p) =>
      p.position_type !== "stock_long" &&
      p.position_type !== "stock_short" &&
      (p.closed_date ?? "") >= from &&
      (p.closed_date ?? "") <= to,
  );
  const windowedStocks = allClosedRaw.filter(
    (p) =>
      (p.position_type === "stock_long" || p.position_type === "stock_short") &&
      (p.closed_date ?? "") >= from &&
      (p.closed_date ?? "") <= to,
  );
  const optionTotal = windowedOptions.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);
  const stockTotal = windowedStocks.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);

  type Agg = {
    key: string;
    symbol: string;
    netPnl: number;
    terminalDate: string;
    optionLegs: Array<{ opened_date: string; closed_date: string | null; strike: number; total_contracts: number }>;
    unresolvedEarnings: boolean;
    memberIds: string[];
  };
  const campaignMap = new Map<string, Agg>();
  for (const p of allClosedRaw) {
    const key = campaignKey(p);
    const cd = p.closed_date ?? "";
    let agg = campaignMap.get(key);
    if (!agg) {
      agg = {
        key,
        symbol: p.symbol,
        netPnl: 0,
        terminalDate: cd,
        optionLegs: [],
        unresolvedEarnings: p.campaign_id === null,
        memberIds: [],
      };
      campaignMap.set(key, agg);
    }
    agg.netPnl += Number(p.realized_pnl ?? 0);
    if (cd > agg.terminalDate) agg.terminalDate = cd;
    agg.memberIds.push(p.id);
    if (p.position_type !== "stock_long" && p.position_type !== "stock_short") {
      agg.optionLegs.push({
        opened_date: p.opened_date,
        closed_date: p.closed_date,
        strike: Number(p.strike),
        total_contracts: Number(p.total_contracts),
      });
    }
  }

  const resolvedCampaigns = Array.from(campaignMap.values()).filter((c) => !openKeys.has(c.key));
  const windowedCampaigns = resolvedCampaigns.filter((c) => c.terminalDate >= from && c.terminalDate <= to);

  let wins = 0,
    losses = 0,
    sumWinPnl = 0,
    sumLossPnl = 0,
    rocSum = 0,
    rocCount = 0;
  let best: { symbol: string; pnl: number } | null = null;
  let worst: { symbol: string; pnl: number } | null = null;
  for (const c of windowedCampaigns) {
    const pnl = c.netPnl;
    if (pnl > 0) {
      wins++;
      sumWinPnl += pnl;
    } else if (pnl < 0) {
      losses++;
      sumLossPnl += pnl;
    }
    const peak = peakCampaignCapital(c.optionLegs);
    if (peak > 0) {
      rocSum += pnl / peak;
      rocCount++;
    }
    if (!best || pnl > best.pnl) best = { symbol: c.symbol, pnl };
    if (!worst || pnl < worst.pnl) worst = { symbol: c.symbol, pnl };
  }
  const total = windowedCampaigns.length;
  const winRate = total > 0 ? wins / total : 0;
  const avgRoc = rocCount > 0 ? rocSum / rocCount : 0;
  const avgWin = wins > 0 ? sumWinPnl / wins : 0;
  const avgLoss = losses > 0 ? sumLossPnl / losses : 0;
  const expectancy = total > 0 ? winRate * avgWin + (1 - winRate) * avgLoss : 0;
  const unresolvedInWindow = windowedCampaigns.filter((c) => c.unresolvedEarnings);

  return {
    from,
    to,
    optionTotal: Math.round(optionTotal * 100) / 100,
    stockTotal: Math.round(stockTotal * 100) / 100,
    combined: Math.round((optionTotal + stockTotal) * 100) / 100,
    campaignCount: total,
    wins,
    losses,
    winRate,
    avgRoc,
    expectancy,
    best,
    worst,
    unresolvedInWindowCount: unresolvedInWindow.length,
    unresolvedInWindowPnl: Math.round(unresolvedInWindow.reduce((s, c) => s + c.netPnl, 0) * 100) / 100,
    windowedCampaigns,
  };
}

// Reconstructs the PRE-Part-1-backfill, row-level, option-only stats
// (win_rate/avg_roc/expectancy/best/worst) exactly as the old
// intelligence/route.ts computed them, by adding back the 3 TSLA
// assigned-option premiums Part 1 zeroed (the only Q3-window rows the
// backfill touched — the other 8 assignment pairs fall in Q2). This is
// the "before" side of the user's requested Q3 comparison.
const TSLA_BACKFILLED_PREMIUMS: Record<string, number> = {
  "9f5af799-72fa-40a9-bb86-c9bdb4820db2": 10100,
  "a9f4de85-9d22-45a7-b9f2-dc14699fe540": 14140,
  "c7e16de3-c262-4a25-b1e3-3110d4a196b1": 2595,
};

async function computeOldRowLevelStats(
  sb: ReturnType<typeof import("../lib/supabase")["createServerClient"]>,
  userId: string,
  from: string,
  to: string,
) {
  const closedRes = await sb
    .from("positions")
    .select("id,symbol,strike,total_contracts,closed_date,realized_pnl,position_type")
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const allClosedRaw = (closedRes.data ?? []) as Row[];
  const windowedOptions = allClosedRaw.filter(
    (p) =>
      p.position_type !== "stock_long" &&
      p.position_type !== "stock_short" &&
      (p.closed_date ?? "") >= from &&
      (p.closed_date ?? "") <= to,
  );

  let wins = 0,
    losses = 0,
    sumWinPnl = 0,
    sumLossPnl = 0,
    rocSum = 0,
    rocCount = 0;
  let best: { symbol: string; pnl: number } | null = null;
  let worst: { symbol: string; pnl: number } | null = null;
  for (const p of windowedOptions) {
    const pnl = Number(p.realized_pnl ?? 0) + (TSLA_BACKFILLED_PREMIUMS[p.id] ?? 0);
    if (pnl > 0) {
      wins++;
      sumWinPnl += pnl;
    } else if (pnl < 0) {
      losses++;
      sumLossPnl += pnl;
    }
    const capital = Number(p.strike) * Number(p.total_contracts) * 100;
    if (capital > 0) {
      rocSum += pnl / capital;
      rocCount++;
    }
    if (!best || pnl > best.pnl) best = { symbol: p.symbol, pnl };
    if (!worst || pnl < worst.pnl) worst = { symbol: p.symbol, pnl };
  }
  const total = windowedOptions.length;
  const winRate = total > 0 ? wins / total : 0;
  const avgRoc = rocCount > 0 ? rocSum / rocCount : 0;
  const avgWin = wins > 0 ? sumWinPnl / wins : 0;
  const avgLoss = losses > 0 ? sumLossPnl / losses : 0;
  const expectancy = total > 0 ? winRate * avgWin + (1 - winRate) * avgLoss : 0;
  return { total, wins, losses, winRate, avgRoc, expectancy, best, worst };
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  console.log("=== Q3 2026 BEFORE (pre-Part-1, row-level, option-only) ===");
  const q3Before = await computeOldRowLevelStats(sb, userId, "2026-07-01", "2026-09-30");
  console.log(JSON.stringify(q3Before, null, 2));

  console.log("\n=== Q3 2026 AFTER (campaign-level) ===");
  const q3 = await computeWindow(sb, userId, "2026-07-01", "2026-09-30");
  console.log(JSON.stringify({ ...q3, windowedCampaigns: undefined }, null, 2));

  const tsla = q3.windowedCampaigns.find((c) => c.symbol === "TSLA" && c.netPnl === 210);
  console.log("\nTSLA $210 campaign found in Q3 window:", !!tsla, tsla ? tsla.key : null);

  const q3CampaignSum =
    Math.round(q3.windowedCampaigns.reduce((s, c) => s + c.netPnl, 0) * 100) / 100;
  console.log(
    `\nQ3: sum of full net P&L across ${q3.windowedCampaigns.length} campaigns terminal in Q3:`,
    q3CampaignSum,
    `(row-level Q3 combined: ${q3.combined}, per-campaign expectancy $${(q3CampaignSum / q3.windowedCampaigns.length).toFixed(2)} vs per-row $${(q3.combined / q3Before.total).toFixed(2)})`,
  );

  const julyCampaignSum =
    Math.round(
      (await computeWindow(sb, userId, "2026-07-01", "2026-07-31")).windowedCampaigns.reduce(
        (s, c) => s + c.netPnl,
        0,
      ) * 100,
    ) / 100;
  console.log("\nJuly: sum of full net P&L across campaigns terminal in July:", julyCampaignSum);

  console.log("\n=== July 2026 (2026-07-01 .. 2026-07-31) — campaign-level ===");
  const july = await computeWindow(sb, userId, "2026-07-01", "2026-07-31");
  console.log(JSON.stringify({ ...july, windowedCampaigns: undefined }, null, 2));
  console.log(
    "\nJuly campaigns:",
    july.windowedCampaigns.map((c) => `${c.symbol} ${c.key.slice(0, 8)} = ${c.netPnl.toFixed(2)}`).join("\n  "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
