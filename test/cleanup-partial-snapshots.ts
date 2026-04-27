// One-time cleanup: remove the 2 partial snapshots I wrote during
// testing when the gate was too loose (INTC strikes that no longer
// existed in the chain on expiry day). Only touches rows with
// option_price=null AND close_snapshot=true written today.
import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const r = await sb
    .from("position_snapshots")
    .select("id,position_id,snapshot_time,stock_price,option_price,current_iv")
    .gte("snapshot_time", since)
    .is("option_price", null)
    .is("current_iv", null);
  const rows = (r.data ?? []) as Array<{ id: string; position_id: string; snapshot_time: string }>;
  console.log(`found ${rows.length} partial rows to delete`);
  for (const row of rows) {
    console.log(`  ${row.snapshot_time} ${row.position_id.slice(0, 8)}`);
  }
  if (rows.length > 0) {
    const d = await sb.from("position_snapshots").delete().in("id", rows.map((r) => r.id));
    console.log(`deleted: error=${d.error?.message ?? "none"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
