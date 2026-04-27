import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  // Insert a sentinel row to read back the full column set, then roll back.
  // Simpler: just SELECT * with limit 1 and see keys (no rows → can't inspect).
  // So we select with limit 0 — PostgREST returns column metadata via the
  // OpenAPI endpoint, but our wrapper doesn't expose that. Try selecting with
  // a known-missing symbol; we get [] with error null.
  const { data, error } = await sb.from("positions").select("*").limit(1);
  console.log("positions sample rows:", data?.length, "error:", error?.message ?? "none");
  if (data && data.length > 0) {
    console.log("columns:", Object.keys(data[0]));
    console.log(JSON.stringify(data[0], null, 2));
  } else {
    console.log("(table is empty — cannot inspect columns via data)");
  }

  // Also try selecting specific columns the snapshot logic will need.
  for (const col of ["opened_date", "entry_stock_price", "entry_em_pct"]) {
    const r = await sb.from("positions").select(col).limit(1);
    console.log(`  col=${col}  error=${r.error?.message ?? "ok"}`);
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
