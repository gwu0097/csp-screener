// Validates the per-campaign tooltip breakdown added to the P&L-by-
// ticker chart (app/api/intelligence/route.ts ticker_pnl[].campaigns),
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
  opened_date: string;
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

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  const from = "2026-07-01";
  const to = "2026-09-30";

  const closedRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,total_contracts,opened_date,closed_date,realized_pnl,status,position_type,campaign_id,trade_chain_id",
    )
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const allClosedRaw = (closedRes.data ?? []) as Row[];

  const campaignsRes = await sb.from("campaigns").select("id,earnings_date").eq("user_id", userId);
  const earningsDateByCampaignId = new Map<string, string>();
  for (const c of (campaignsRes.data ?? []) as Array<{ id: string; earnings_date: string }>) {
    earningsDateByCampaignId.set(c.id, c.earnings_date);
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

  type TCAgg = { pnl: number; optionLegs: Array<{ opened_date: string; closed_date: string | null; strike: number; total_contracts: number }> };
  const bySymbol = new Map<string, Map<string, TCAgg>>();
  const add = (symbol: string, key: string, pnl: number, leg: TCAgg["optionLegs"][number] | null) => {
    let m = bySymbol.get(symbol);
    if (!m) { m = new Map(); bySymbol.set(symbol, m); }
    let agg = m.get(key);
    if (!agg) { agg = { pnl: 0, optionLegs: [] }; m.set(key, agg); }
    agg.pnl += pnl;
    if (leg) agg.optionLegs.push(leg);
  };
  for (const p of windowed) {
    const key = campaignKey(p);
    add(p.symbol, key, Number(p.realized_pnl ?? 0), {
      opened_date: p.opened_date,
      closed_date: p.closed_date,
      strike: Number(p.strike),
      total_contracts: Number(p.total_contracts),
    });
  }
  for (const p of windowedStocks) {
    add(p.symbol, campaignKey(p), Number(p.realized_pnl ?? 0), null);
  }

  function reportTicker(symbol: string) {
    const m = bySymbol.get(symbol);
    if (!m) {
      console.log(`${symbol}: no windowed activity`);
      return;
    }
    const rows = Array.from(m.entries()).map(([key, agg]) => {
      const earningsDate = earningsDateByCampaignId.get(key) ?? null;
      const fallbackDate = agg.optionLegs.length > 0
        ? agg.optionLegs.reduce((min, l) => (l.opened_date < min ? l.opened_date : min), agg.optionLegs[0].opened_date)
        : from;
      const strikes = Array.from(new Set(agg.optionLegs.map((l) => l.strike))).sort((a, b) => a - b);
      const contracts = agg.optionLegs.reduce((s, l) => s + l.total_contracts, 0);
      const collateral = peakCampaignCapital(agg.optionLegs);
      const pnl = Math.round(agg.pnl * 100) / 100;
      return {
        key,
        date: earningsDate ?? fallbackDate,
        dateIsEarnings: earningsDate !== null,
        strikes,
        contracts,
        collateral,
        pnl,
        roc: collateral > 0 ? pnl / collateral : null,
      };
    }).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

    const totalNet = Math.round(rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100;
    console.log(`\n=== ${symbol} — Q3 2026 — ${rows.length} campaign(s) ===`);
    for (const r of rows) {
      const strikeLabel = r.strikes.length <= 1 ? `$${r.strikes[0] ?? "—"}` : `$${r.strikes[0]}-${r.strikes[r.strikes.length - 1]}`;
      const dateLabel = new Date(r.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const dateStr = r.dateIsEarnings ? dateLabel : `~${dateLabel}`;
      const roc = r.roc !== null ? ` (${(r.roc * 100).toFixed(1)}%)` : "";
      console.log(`  ${dateStr} · ${strikeLabel} x ${r.contracts} · $${r.collateral.toLocaleString()} · ${r.pnl >= 0 ? "+" : ""}$${r.pnl}${roc}`);
    }
    console.log(`  SUM of campaign rows: ${totalNet}`);
    console.log(`  (cross-check against ticker_pnl's own totalNet for ${symbol} — must match exactly)`);
  }

  reportTicker("GWRE");
  reportTicker("DHR");

  // Single-campaign ticker check — find any symbol with exactly 1
  // campaign touching it in Q3.
  console.log("\n=== Single-campaign tickers in Q3 (for the '+N more' absence check) ===");
  let found = 0;
  for (const [symbol, m] of Array.from(bySymbol.entries())) {
    if (m.size === 1 && found < 3) {
      reportTicker(symbol);
      found++;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
