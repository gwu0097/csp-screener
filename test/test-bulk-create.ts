// Local end-to-end test of the rebuilt bulk-create logic.
// Calls the API handler directly against the real Supabase (via .env.local).
// Asserts the expected position state + P&L numbers from STEP 8.
//
// Run: env -u GEMINI_API_KEY node --env-file=.env.local --import=tsx test/test-bulk-create.ts

import { createClient } from "@supabase/supabase-js";
import { POST } from "../app/api/trades/bulk-create/route";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sbRaw = createClient(url, key, { auth: { persistSession: false } });

function mkReq(body: unknown): Request {
  return new Request("http://localhost/api/trades/bulk-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callBulk(trades: unknown[]) {
  // Next.js route handlers accept a Request-compatible input. NextRequest
  // adds nextUrl but this handler only reads req.json(), so a plain Request
  // is fine at runtime.
  const res = await POST(mkReq({ trades }) as unknown as Parameters<typeof POST>[0]);
  return res.json();
}

async function clearAll() {
  // Delete fills first (FK), then positions.
  await sbRaw.from("fills").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sbRaw.from("positions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

async function fetchPosition(symbol: string, strike: number, expiry: string) {
  const { data: positions } = await sbRaw
    .from("positions")
    .select("*")
    .eq("symbol", symbol)
    .eq("strike", strike)
    .eq("expiry", expiry);
  return (positions ?? [])[0] ?? null;
}

async function fetchFills(positionId: string) {
  const { data } = await sbRaw
    .from("fills")
    .select("*")
    .eq("position_id", positionId)
    .order("fill_date", { ascending: true });
  return data ?? [];
}

function approx(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

async function test1() {
  console.log("\n=== TEST 1: Simple open + full close on NOW 85 PUT ===");
  await clearAll();

  const trades = [
    {
      symbol: "NOW", strike: 85, expiry: "2026-04-26",
      action: "open", contracts: 4, premium: 0.27,
      broker: "schwab", timePlaced: "2026-04-22",
    },
    {
      symbol: "NOW", strike: 85, expiry: "2026-04-26",
      action: "close", contracts: 4, premium: 0.08,
      broker: "schwab", timePlaced: "2026-04-22",
    },
  ];

  const result = await callBulk(trades);
  console.log("  API result:", JSON.stringify(result));

  const pos = await fetchPosition("NOW", 85, "2026-04-26");
  const fills = pos ? await fetchFills(pos.id) : [];
  console.log(`  positions: ${pos ? 1 : 0}, fills: ${fills.length}`);
  if (pos) {
    console.log(`  status=${pos.status} total_contracts=${pos.total_contracts} avg_premium_sold=${pos.avg_premium_sold} realized_pnl=${pos.realized_pnl} closed_date=${pos.closed_date}`);
  }

  const expectedPnl = 76;
  const checks: Array<[string, boolean]> = [
    ["1 position created", result.positions_created === 1],
    ["2 fills inserted", result.fills_inserted === 2],
    ["position status=closed", pos?.status === "closed"],
    ["total_contracts=4", pos?.total_contracts === 4],
    [`realized_pnl=$${expectedPnl}`, pos && approx(Number(pos.realized_pnl), expectedPnl)],
    ["closed_date set", !!pos?.closed_date],
  ];
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`);
    if (!passed) ok = false;
  }
  return ok;
}

async function test2() {
  console.log("\n=== TEST 2: Multi-tranche GE 277.5 PUT (3+3 opens, 6 close) ===");
  await clearAll();

  const trades = [
    {
      symbol: "GE", strike: 277.5, expiry: "2026-04-26",
      action: "open", contracts: 3, premium: 0.79,
      broker: "schwab", timePlaced: "2026-04-20",
    },
    {
      symbol: "GE", strike: 277.5, expiry: "2026-04-26",
      action: "open", contracts: 3, premium: 0.81,
      broker: "schwab", timePlaced: "2026-04-20",
    },
    {
      symbol: "GE", strike: 277.5, expiry: "2026-04-26",
      action: "close", contracts: 6, premium: 7.15,
      broker: "schwab", timePlaced: "2026-04-22",
    },
  ];

  const result = await callBulk(trades);
  console.log("  API result:", JSON.stringify(result));

  const pos = await fetchPosition("GE", 277.5, "2026-04-26");
  const fills = pos ? await fetchFills(pos.id) : [];
  console.log(`  positions: ${pos ? 1 : 0}, fills: ${fills.length}`);
  if (pos) {
    console.log(`  status=${pos.status} total_contracts=${pos.total_contracts} avg_premium_sold=${pos.avg_premium_sold} realized_pnl=${pos.realized_pnl}`);
  }

  // Expected avg = (0.79*3 + 0.81*3) / 6 = 0.80
  // Expected pnl = (0.80 - 7.15) * 6 * 100 = -3810
  const expectedAvg = 0.8;
  const expectedPnl = -3810;
  const checks: Array<[string, boolean]> = [
    ["1 position created (not 2)", result.positions_created === 1],
    ["3 fills inserted", result.fills_inserted === 3],
    ["position status=closed", pos?.status === "closed"],
    ["total_contracts=6", pos?.total_contracts === 6],
    [`avg_premium_sold=$${expectedAvg}`, pos && approx(Number(pos.avg_premium_sold), expectedAvg)],
    [`realized_pnl=$${expectedPnl}`, pos && approx(Number(pos.realized_pnl), expectedPnl)],
  ];
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`);
    if (!passed) ok = false;
  }
  return ok;
}

async function main() {
  const r1 = await test1();
  const r2 = await test2();
  console.log("\n=== RESULTS ===");
  console.log(`  test 1: ${r1 ? "PASS" : "FAIL"}`);
  console.log(`  test 2: ${r2 ? "PASS" : "FAIL"}`);

  // Clean up test artifacts.
  await clearAll();
  console.log("  (cleaned up)");

  if (!r1 || !r2) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
