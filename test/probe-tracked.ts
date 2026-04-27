// Quick schema probe for tracked_tickers + position_snapshots + positions.
import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  for (const t of ["tracked_tickers", "position_snapshots", "positions"]) {
    const { data, error } = await sb.from(t).select("*").limit(1);
    if (error) {
      console.log(`${t}: ERROR ${error.message}`);
    } else {
      const row = (data ?? [])[0];
      const cols = row ? Object.keys(row) : [];
      console.log(`${t}: exists, ${data?.length ?? 0} rows, columns: [${cols.join(", ")}]`);
    }
  }
}
main().catch(console.error);
