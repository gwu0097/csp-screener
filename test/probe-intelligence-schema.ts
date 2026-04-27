import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  for (const t of ["positions", "fills", "market_context", "post_earnings_recommendations"]) {
    const r = await sb.from(t).select("*").limit(1);
    const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
    console.log(`\n=== ${t} ===`);
    console.log(`  error=${r.error?.message ?? "none"}  rows=${r.data?.length ?? 0}`);
    if (row) console.log(`  columns: ${Object.keys(row).join(", ")}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
