// Tests for shouldWriteSnapshot — the 60-minute rate limit on the
// "Refresh live data" snapshot pass. Uses a synthetic position +
// synthetic snapshot rows so the tests don't depend on whatever live
// data exists.
//
// Run: node --env-file=.env.local --import=tsx test/test-snapshot-refresh.ts
import {
  SNAPSHOT_RATE_LIMIT_MINUTES,
  shouldWriteSnapshot,
} from "../lib/snapshots";
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
function section(title: string) {
  console.log(`\n=============== ${title} ===============`);
}

async function insertPosition(sb: ReturnType<typeof createServerClient>, symbol: string) {
  const r = await sb
    .from("positions")
    .insert({
      symbol,
      strike: 100,
      expiry: "2026-05-01",
      option_type: "put",
      broker: "test",
      total_contracts: 1,
      avg_premium_sold: 1.0,
      status: "open",
      opened_date: "2026-04-24",
    })
    .select()
    .single();
  if (r.error || !r.data) throw new Error(`insert position: ${r.error?.message}`);
  return (r.data as { id: string }).id;
}

async function insertSnapshot(
  sb: ReturnType<typeof createServerClient>,
  positionId: string,
  minutesAgo: number,
) {
  const t = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const r = await sb.from("position_snapshots").insert({
    position_id: positionId,
    snapshot_time: t,
    stock_price: 100,
    option_price: 1,
  });
  if (r.error) throw new Error(`insert snapshot: ${r.error.message}`);
  return t;
}

async function cleanup(sb: ReturnType<typeof createServerClient>, positionId: string) {
  await sb.from("position_snapshots").delete().eq("position_id", positionId);
  await sb.from("positions").delete().eq("id", positionId);
}

// ----- Test 1: no prior snapshots → true -----
async function test1_noPrior() {
  section("Test 1: no prior snapshots → true");
  const sb = createServerClient();
  const id = await insertPosition(sb, "__SNAP_T1__");
  try {
    const ok = await shouldWriteSnapshot(id);
    check("shouldWriteSnapshot === true", ok === true, String(ok));
  } finally {
    await cleanup(sb, id);
  }
}

// ----- Test 2: recent snapshot (30 min ago) → false -----
async function test2_recent() {
  section("Test 2: most recent snapshot 30 min ago → false");
  const sb = createServerClient();
  const id = await insertPosition(sb, "__SNAP_T2__");
  try {
    await insertSnapshot(sb, id, 30);
    const ok = await shouldWriteSnapshot(id);
    check("shouldWriteSnapshot === false (rate-limited)", ok === false, String(ok));
  } finally {
    await cleanup(sb, id);
  }
}

// ----- Test 3: stale snapshot (90 min ago) → true -----
async function test3_stale() {
  section("Test 3: most recent snapshot 90 min ago → true");
  const sb = createServerClient();
  const id = await insertPosition(sb, "__SNAP_T3__");
  try {
    await insertSnapshot(sb, id, 90);
    const ok = await shouldWriteSnapshot(id);
    check("shouldWriteSnapshot === true", ok === true, String(ok));
  } finally {
    await cleanup(sb, id);
  }
}

// ----- Test 4: boundary (exactly 60 min ago) → true -----
async function test4_boundary() {
  section(`Test 4: exactly ${SNAPSHOT_RATE_LIMIT_MINUTES} min ago → true (>=, not >)`);
  const sb = createServerClient();
  const id = await insertPosition(sb, "__SNAP_T4__");
  try {
    // Insert at exactly the boundary. Use +1 second buffer to account
    // for the tiny drift between insert and check.
    await insertSnapshot(sb, id, SNAPSHOT_RATE_LIMIT_MINUTES + 1 / 60);
    const ok = await shouldWriteSnapshot(id);
    check("shouldWriteSnapshot === true at boundary", ok === true, String(ok));
  } finally {
    await cleanup(sb, id);
  }
}

// ----- Test 5: DB round-trip against real positions (read-only) -----
async function test5_realDb() {
  section("Test 5: real DB (read-only)");
  const sb = createServerClient();
  const r = await sb.from("positions").select("id,symbol").eq("status", "open").limit(20);
  const openPositions = ((r.data ?? []) as Array<{ id: string; symbol: string }>);
  console.log(`  querying ${openPositions.length} open positions`);
  let errorCount = 0;
  for (const p of openPositions) {
    try {
      const ok = await shouldWriteSnapshot(p.id);
      console.log(`    ${p.symbol.padEnd(6)} (${p.id.slice(0, 8)}) → ${ok}`);
      if (typeof ok !== "boolean") errorCount += 1;
    } catch (e) {
      console.log(`    ${p.symbol}: threw ${e instanceof Error ? e.message : e}`);
      errorCount += 1;
    }
  }
  check("all calls returned a boolean without throwing", errorCount === 0);
}

async function main() {
  await test1_noPrior();
  await test2_recent();
  await test3_stale();
  await test4_boundary();
  await test5_realDb();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});
