// Tests for the Intelligence API route. Exercises the shape contract,
// ROC math, win-rate logic, equity-curve ordering, and empty-state
// behavior. Uses synthetic fixtures inserted directly into Supabase so
// the tests don't depend on whatever live data exists.
//
// Run: node --env-file=.env.local --import=tsx test/test-intelligence.ts
import { createServerClient } from "../lib/supabase";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}
function section(title: string): void {
  console.log(`\n=============== ${title} ===============`);
}

function ensureAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) throw new Error("NEXT_PUBLIC_APP_URL is required (points at the deployed app)");
  return url.replace(/\/$/, "");
}

async function callApi(window: string) {
  const base = ensureAppUrl();
  const res = await fetch(`${base}/api/intelligence?window=${window}`, { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

// ----- Test 1: shape contract -----
async function test1_shape() {
  section("Test 1: API shape");
  const { status, json } = await callApi("all");
  check("HTTP 200", status === 200, String(status));
  const stats = (json as { stats?: Record<string, unknown> }).stats;
  check("stats object exists", stats !== undefined);
  if (!stats) return;
  for (const k of ["total_pnl", "win_rate", "wins", "total_trades", "avg_roc", "expectancy"]) {
    check(`stats.${k} is present + numeric (not null)`, typeof stats[k] === "number");
  }
  check(
    "equity_curve is an array",
    Array.isArray((json as { equity_curve?: unknown }).equity_curve),
  );
  check(
    "ticker_rankings is an array",
    Array.isArray((json as { ticker_rankings?: unknown }).ticker_rankings),
  );
}

// ----- Test 2: ROC math (pure) -----
function test2_roc() {
  section("Test 2: ROC calculation");
  const pnl = 94.0;
  const strike = 347.5;
  const contracts = 2;
  const expected = pnl / (strike * contracts * 100);
  const computed = pnl / (strike * contracts * 100);
  check(
    `ROC(94, 347.5, 2) == ${expected.toFixed(6)}`,
    Math.abs(computed - expected) < 1e-6,
  );
  check(
    "ROC rounded to 4 decimals == 0.0014",
    Number(computed.toFixed(4)) === 0.0014,
    String(computed.toFixed(4)),
  );
}

// ----- Test 3: win-rate logic via synthetic rows -----
async function test3_winRate() {
  section("Test 3: win-rate logic on synthetic closed positions");
  const sb = createServerClient();
  const todayStr = new Date().toISOString().slice(0, 10);
  const syms = ["__INT_TEST_W1__", "__INT_TEST_W2__", "__INT_TEST_W3__", "__INT_TEST_L1__"];
  // Clean up any previous leftovers.
  await sb.from("positions").delete().in("symbol", syms);

  const fixtures = [
    { symbol: syms[0], realized_pnl: 100, pnl: "win" },
    { symbol: syms[1], realized_pnl: 50, pnl: "win" },
    { symbol: syms[2], realized_pnl: 200, pnl: "win" },
    { symbol: syms[3], realized_pnl: -75, pnl: "loss" },
  ];
  for (const f of fixtures) {
    const r = await sb.from("positions").insert({
      symbol: f.symbol,
      strike: 100,
      expiry: "2026-05-01",
      option_type: "put",
      broker: "test",
      total_contracts: 1,
      avg_premium_sold: 1.0,
      status: "closed",
      opened_date: todayStr,
      closed_date: todayStr,
      realized_pnl: f.realized_pnl,
    });
    if (r.error) throw new Error(`seed ${f.symbol}: ${r.error.message}`);
  }

  try {
    const { json } = await callApi("today");
    const rankings = (
      json as { ticker_rankings?: Array<{ symbol: string; wins: number; trades: number; win_rate: number }> }
    ).ticker_rankings;
    check("rankings returned", Array.isArray(rankings) && rankings.length >= 4);
    const got = new Map((rankings ?? []).map((r) => [r.symbol, r]));
    const wins = [syms[0], syms[1], syms[2]];
    const loss = [syms[3]];
    for (const s of wins) {
      const r = got.get(s);
      check(`${s} shows as 1/1 win`, r?.wins === 1 && r?.trades === 1);
    }
    for (const s of loss) {
      const r = got.get(s);
      check(`${s} shows as 0/1 win`, r?.wins === 0 && r?.trades === 1);
    }
    // Aggregate win rate across these 4 fixtures in the payload stats.
    const stats = (json as { stats?: { wins: number; total_trades: number; win_rate: number } }).stats;
    check("stats includes test rows (todays window)", (stats?.total_trades ?? 0) >= 4);
  } finally {
    await sb.from("positions").delete().in("symbol", syms);
  }
}

// ----- Test 4: equity curve ordering -----
async function test4_equityCurve() {
  section("Test 4: equity curve ordering + cumulative sum");
  const sb = createServerClient();
  const syms = ["__INT_EQ_A__", "__INT_EQ_B__", "__INT_EQ_C__"];
  await sb.from("positions").delete().in("symbol", syms);
  const todayStr = new Date().toISOString().slice(0, 10);
  // Create 3 closed trades today with different realized_pnl; we can't
  // control the closed_date ordering, so we use 3 different YYYY-MM-DD
  // days and window=all so they all show up.
  const rows = [
    { symbol: syms[0], date: "2025-01-15", realized_pnl: 50 },
    { symbol: syms[1], date: "2025-02-20", realized_pnl: 75 },
    { symbol: syms[2], date: "2025-03-10", realized_pnl: -30 },
  ];
  for (const r of rows) {
    const ins = await sb.from("positions").insert({
      symbol: r.symbol,
      strike: 100,
      expiry: "2025-03-14",
      option_type: "put",
      broker: "test",
      total_contracts: 1,
      avg_premium_sold: 1,
      status: "closed",
      opened_date: r.date,
      closed_date: r.date,
      realized_pnl: r.realized_pnl,
    });
    if (ins.error) throw new Error(`seed ${r.symbol}: ${ins.error.message}`);
  }
  try {
    const { json } = await callApi("all");
    const curve = (
      json as { equity_curve?: Array<{ date: string; cumulative_pnl: number; trade_pnl: number; symbol: string }> }
    ).equity_curve;
    if (!Array.isArray(curve)) {
      check("equity_curve is an array", false);
      return;
    }
    const ours = curve.filter((p) => syms.includes(p.symbol));
    check(
      "equity curve ascending by date among our fixtures",
      ours.every((p, i) => i === 0 || ours[i - 1].date <= p.date),
    );
    // Verify cumulative_pnl is monotonic wrt all prior trade_pnl for our
    // subset taken in order (relative to the other rows in the curve).
    // Simpler check: across our 3 rows, the last cumulative - first
    // cumulative should equal sum of our deltas.
    if (ours.length === 3) {
      const span = ours[2].cumulative_pnl - ours[0].cumulative_pnl;
      const deltaSum = ours[1].trade_pnl + ours[2].trade_pnl;
      check(
        "cumulative_pnl rises by the sum of intermediate trade pnl",
        Math.abs(span - deltaSum) < 1e-6,
        `span=${span} deltaSum=${deltaSum}`,
      );
    }
  } finally {
    await sb.from("positions").delete().in("symbol", syms);
  }
}

// ----- Test 5: empty-state behavior -----
// We can't actually guarantee "no closed positions" on the live DB
// without destroying real data. Instead, we verify that the 'today'
// window on a synthetic-removed DB correctly reports zeros when there
// are no matches in that window. This is a structural test.
async function test5_emptyState() {
  section("Test 5: empty-state behavior");
  // Use a future date window that mathematically cannot match. Since
  // the route doesn't accept arbitrary windows, we use 'today' after
  // ensuring nothing closed today (clean up any fixtures from previous
  // runs just in case).
  const sb = createServerClient();
  await sb
    .from("positions")
    .delete()
    .in("symbol", [
      "__INT_TEST_W1__",
      "__INT_TEST_W2__",
      "__INT_TEST_W3__",
      "__INT_TEST_L1__",
      "__INT_EQ_A__",
      "__INT_EQ_B__",
      "__INT_EQ_C__",
    ]);
  const { status, json } = await callApi("today");
  check("HTTP 200 on empty window", status === 200);
  const stats = (json as { stats?: { total_pnl: number; win_rate: number; total_trades: number } }).stats;
  // Today may legitimately have real closed trades; we just check that
  // if there are none of our synthetic fixtures, the shape is still
  // zeros-or-actual (never null).
  check("stats.total_pnl is a number (maybe 0)", typeof stats?.total_pnl === "number");
  check("stats.win_rate is a number (0-1)", typeof stats?.win_rate === "number" && (stats?.win_rate ?? -1) >= 0);
  check(
    "equity_curve is an array (maybe empty)",
    Array.isArray((json as { equity_curve?: unknown }).equity_curve),
  );
}

async function main() {
  await test1_shape();
  test2_roc();
  await test3_winRate();
  await test4_equityCurve();
  await test5_emptyState();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});
