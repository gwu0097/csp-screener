// Validates the new P&L-by-ticker bar chart (app/api/intelligence/route.ts
// ticker_pnl) against real data, independent of the running server.
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

async function computeTickerPnl(
  sb: ReturnType<typeof import("../lib/supabase")["createServerClient"]>,
  userId: string,
  from: string,
  to: string,
) {
  const closedRes = await sb
    .from("positions")
    .select("id,symbol,closed_date,realized_pnl,status,position_type,campaign_id,trade_chain_id")
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const allClosedRaw = (closedRes.data ?? []) as Row[];

  const openRes = await sb
    .from("positions")
    .select("id,campaign_id,trade_chain_id")
    .eq("user_id", userId)
    .eq("status", "open");
  const openKeys = new Set(
    ((openRes.data ?? []) as Array<{ id: string; campaign_id: string | null; trade_chain_id: string | null }>).map(
      (p) => campaignKey(p),
    ),
  );

  const campaignMap = new Map<string, number>(); // key -> netPnl (all-time)
  for (const p of allClosedRaw) {
    const key = campaignKey(p);
    campaignMap.set(key, (campaignMap.get(key) ?? 0) + Number(p.realized_pnl ?? 0));
  }

  const windowed = allClosedRaw.filter(
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

  const tickerMap = new Map<string, { optionsNet: number; stockNet: number; campaignKeys: Set<string> }>();
  const add = (symbol: string, key: string, isStock: boolean, pnl: number) => {
    let t = tickerMap.get(symbol);
    if (!t) {
      t = { optionsNet: 0, stockNet: 0, campaignKeys: new Set() };
      tickerMap.set(symbol, t);
    }
    if (isStock) t.stockNet += pnl;
    else t.optionsNet += pnl;
    t.campaignKeys.add(key);
  };
  for (const p of windowed) add(p.symbol, campaignKey(p), false, Number(p.realized_pnl ?? 0));
  for (const p of windowedStocks) add(p.symbol, campaignKey(p), true, Number(p.realized_pnl ?? 0));

  const ticker_pnl = Array.from(tickerMap.entries())
    .map(([symbol, t]) => {
      let resolvedCount = 0;
      let wins = 0;
      for (const key of Array.from(t.campaignKeys)) {
        if (openKeys.has(key)) continue;
        resolvedCount++;
        if ((campaignMap.get(key) ?? 0) > 0) wins++;
      }
      return {
        symbol,
        optionsNet: Math.round(t.optionsNet * 100) / 100,
        stockNet: Math.round(t.stockNet * 100) / 100,
        totalNet: Math.round((t.optionsNet + t.stockNet) * 100) / 100,
        campaignCount: resolvedCount,
        winRate: resolvedCount > 0 ? wins / resolvedCount : null,
      };
    })
    .sort((a, b) => Math.abs(b.totalNet) - Math.abs(a.totalNet));

  const optionTotal = windowed.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);
  const stockTotal = windowedStocks.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);
  const combined = Math.round((optionTotal + stockTotal) * 100) / 100;
  const barSum = Math.round(ticker_pnl.reduce((s, t) => s + t.totalNet, 0) * 100) / 100;

  const grossAbs = ticker_pnl.reduce((s, t) => s + Math.abs(t.totalNet), 0);
  const top3 = ticker_pnl.slice(0, 3);
  const top3Abs = top3.reduce((s, t) => s + Math.abs(t.totalNet), 0);
  const concentrationPct = grossAbs > 0 ? (top3Abs / grossAbs) * 100 : 0;

  return { from, to, combined, barSum, delta: Math.round((barSum - combined) * 100) / 100, tickerCount: ticker_pnl.length, top3, concentrationPct, ticker_pnl };
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  console.log("=== Q3 2026 (2026-07-01..2026-09-30) ===");
  const q3 = await computeTickerPnl(sb, userId, "2026-07-01", "2026-09-30");
  console.log(`combined_realized_pnl=${q3.combined}  sum(bars)=${q3.barSum}  delta=${q3.delta}`);
  console.log(`tickers=${q3.tickerCount}  top3=${q3.top3.map((t) => `${t.symbol}:${t.totalNet}`).join(", ")}`);
  console.log(`concentration (top3/gross abs) = ${q3.concentrationPct.toFixed(1)}%`);

  console.log("\n=== July 2026 (2026-07-01..2026-07-31) ===");
  const july = await computeTickerPnl(sb, userId, "2026-07-01", "2026-07-31");
  console.log(`combined_realized_pnl=${july.combined}  sum(bars)=${july.barSum}  delta=${july.delta}`);
  console.log(`tickers=${july.tickerCount}  top3=${july.top3.map((t) => `${t.symbol}:${t.totalNet}`).join(", ")}`);
  console.log(`concentration (top3/gross abs) = ${july.concentrationPct.toFixed(1)}%`);
  const tsla = july.ticker_pnl.find((t) => t.symbol === "TSLA");
  console.log(`TSLA July bar: ${JSON.stringify(tsla)}`);

  console.log("\n=== All-time (2000-01-01..2099-01-01) — tests the >30 cap path ===");
  const allTime = await computeTickerPnl(sb, userId, "2000-01-01", "2099-01-01");
  console.log(`tickers=${allTime.tickerCount} (>${30} triggers others-bar: ${allTime.tickerCount > 30})`);
  console.log(`combined=${allTime.combined} sum(bars)=${allTime.barSum} delta=${allTime.delta}`);

  console.log("\n=== A short window likely <30 tickers: last 7 days ===");
  const week = await computeTickerPnl(sb, userId, "2026-08-06", "2026-08-13");
  console.log(`tickers=${week.tickerCount} (<=30: ${week.tickerCount <= 30})`);
  console.log(`combined=${week.combined} sum(bars)=${week.barSum} delta=${week.delta}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
