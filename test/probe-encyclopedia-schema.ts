import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  // First — row count (don't blow anything away without knowing).
  const count = await sb.from("earnings_history").select("id");
  console.log(
    `earnings_history existing rows: ${count.data?.length ?? 0} (error=${count.error?.message ?? "none"})`,
  );

  // Sample an existing row so we can see every column.
  const sample = await sb.from("earnings_history").select("*").limit(1);
  const rows = (sample.data ?? []) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    console.log("\ncolumns on existing earnings_history row:");
    for (const k of Object.keys(rows[0])) console.log(`  ${k}`);
    console.log("\nfirst row values:");
    for (const [k, v] of Object.entries(rows[0]))
      console.log(`  ${k.padEnd(28)} = ${JSON.stringify(v)}`);
  } else {
    console.log("\n(table has no rows — can't sample columns)");
    // Try probe inserts with increasing completeness to discover required fields.
    const probes = [
      { symbol: "__P__", earnings_date: "1990-01-01", earnings_timing: "AMC" },
      { symbol: "__P__", earnings_date: "1990-01-02", earnings_timing: "AMC", analyst_sentiment: "neutral" },
    ];
    for (const p of probes) {
      const ins = await sb.from("earnings_history").insert(p).select().single();
      if (ins.error) {
        console.log(`  probe ${JSON.stringify(p)} → ${ins.error.message}`);
      } else {
        const row = ins.data as Record<string, unknown>;
        console.log("  success. columns:");
        for (const k of Object.keys(row)) console.log(`    ${k}`);
        await sb.from("earnings_history").delete().eq("symbol", "__P__");
        break;
      }
    }
  }

  // stock_encyclopedia
  const enc = await sb.from("stock_encyclopedia").select("*").limit(1);
  const encRows = (enc.data ?? []) as Array<Record<string, unknown>>;
  console.log(
    `\nstock_encyclopedia existing rows: ${enc.data?.length ?? 0} (error=${enc.error?.message ?? "none"})`,
  );
  if (encRows.length > 0) {
    console.log("columns on existing stock_encyclopedia row:");
    for (const k of Object.keys(encRows[0])) console.log(`  ${k}`);
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
