// End-to-end test: tracked_tickers upsert → bulk-create merge of entry_*
// fields onto a newly-created position.
//
// Run: env -u GEMINI_API_KEY -u PERPLEXITY_API_KEY node --env-file=.env.local --import=tsx test/test-tracked-merge.ts
import { createClient } from "@supabase/supabase-js";
import { POST } from "../app/api/trades/bulk-create/route";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sb = createClient(url, key, { auth: { persistSession: false } });

function mkReq(body: unknown): Request {
  return new Request("http://localhost/api/trades/bulk-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function cleanup() {
  await sb.from("fills").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("positions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("tracked_tickers").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

async function main() {
  await cleanup();

  // 1. Seed a tracked_tickers row as if Run Analysis on 2026-04-22 captured
  //    grades for AXP.
  const screenedDate = "2026-04-22";
  const { error: upsertErr } = await sb.from("tracked_tickers").upsert(
    {
      symbol: "AXP",
      expiry: "2026-04-26",
      screened_date: screenedDate,
      suggested_strike: 312.5,
      entry_crush_grade: "A",
      entry_opportunity_grade: "B",
      entry_final_grade: "A",
      entry_iv_edge: 1.42,
      entry_em_pct: 0.065,
      entry_vix: 18.92,
      entry_news_summary: "No material headlines ahead of earnings.",
      entry_stock_price: 320.15,
    },
    { onConflict: "symbol,expiry,screened_date" },
  );
  if (upsertErr) {
    console.error("seed tracked_tickers failed:", upsertErr);
    process.exit(1);
  }
  console.log("seeded tracked_tickers for AXP");

  // 2. Bulk-create an OPEN fill for AXP with fill_date = same day.
  const body = {
    trades: [
      {
        symbol: "AXP",
        strike: 312.5,
        expiry: "2026-04-26",
        action: "open",
        contracts: 2,
        premium: 0.8,
        broker: "schwab",
        timePlaced: screenedDate,
      },
    ],
  };
  const res = await POST(mkReq(body) as unknown as Parameters<typeof POST>[0]);
  const result = await res.json();
  console.log("bulk-create result:", result);

  // 3. Read back the position — should have entry_* merged.
  const { data: posRows } = await sb
    .from("positions")
    .select(
      "symbol, strike, entry_crush_grade, entry_opportunity_grade, entry_final_grade, entry_iv_edge, entry_em_pct, entry_vix, entry_news_summary, entry_stock_price",
    )
    .eq("symbol", "AXP");
  const p = (posRows ?? [])[0];
  console.log("\nposition after merge:");
  console.log(p);

  let pass = 0,
    fail = 0;
  const check = (label: string, ok: boolean) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (ok) pass += 1;
    else fail += 1;
  };
  check("position created", !!p);
  check("entry_crush_grade = A", p?.entry_crush_grade === "A");
  check("entry_opportunity_grade = B", p?.entry_opportunity_grade === "B");
  check("entry_final_grade = A", p?.entry_final_grade === "A");
  check("entry_iv_edge ≈ 1.42", Number(p?.entry_iv_edge) === 1.42);
  check("entry_vix ≈ 18.92", Number(p?.entry_vix) === 18.92);
  check("entry_news_summary preserved", p?.entry_news_summary?.includes("material"));

  // 4. Previous-day case: tracked_ticker for 2026-04-21, fill on 2026-04-22.
  await cleanup();
  await sb.from("tracked_tickers").upsert({
    symbol: "NOW",
    expiry: "2026-04-26",
    screened_date: "2026-04-21",
    suggested_strike: 85,
    entry_crush_grade: "B",
    entry_opportunity_grade: "A",
    entry_final_grade: "B",
    entry_iv_edge: 1.35,
    entry_em_pct: 0.055,
    entry_vix: 19.5,
    entry_news_summary: "Analyst upgrades ahead of Q1.",
    entry_stock_price: 87.0,
  });
  console.log("\nseeded tracked_tickers for NOW (screened 2026-04-21)");

  const res2 = await POST(
    mkReq({
      trades: [
        {
          symbol: "NOW",
          strike: 85,
          expiry: "2026-04-26",
          action: "open",
          contracts: 4,
          premium: 0.27,
          broker: "schwab",
          timePlaced: "2026-04-22", // BMO fill day after screen
        },
      ],
    }) as unknown as Parameters<typeof POST>[0],
  );
  const result2 = await res2.json();
  console.log("bulk-create result:", result2);
  const { data: pos2 } = await sb
    .from("positions")
    .select("entry_crush_grade, entry_final_grade, entry_news_summary")
    .eq("symbol", "NOW");
  const p2 = (pos2 ?? [])[0];
  check("BMO merge picks up prev-day grades", p2?.entry_crush_grade === "B");
  check("BMO merge final = B", p2?.entry_final_grade === "B");
  check("BMO merge news preserved", p2?.entry_news_summary?.includes("upgrades"));

  await cleanup();
  console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
