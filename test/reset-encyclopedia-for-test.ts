// Full reset for a clean test: delete existing earnings_history rows for
// the test symbols and null out their encyclopedia pull markers.
import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  for (const sym of ["NOW", "TSLA"]) {
    const d = await sb.from("earnings_history").delete().eq("symbol", sym);
    const u = await sb
      .from("stock_encyclopedia")
      .update({ last_historical_pull_date: null, total_earnings_records: 0 })
      .eq("symbol", sym);
    console.log(
      `reset ${sym}: delete_err=${d.error?.message ?? "none"} update_err=${u.error?.message ?? "none"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
