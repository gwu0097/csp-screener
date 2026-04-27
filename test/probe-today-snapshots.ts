import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  const todayStr = new Date().toISOString().slice(0, 10);
  const r = await sb
    .from("position_snapshots")
    .select("position_id,snapshot_time,close_snapshot,stock_price,option_price,current_iv,current_delta,current_theta")
    .gte("snapshot_time", todayStr + "T00:00:00Z")
    .order("snapshot_time", { ascending: false })
    .limit(20);
  const rows = (r.data ?? []) as Array<Record<string, unknown>>;
  console.log(`today's snapshots: ${rows.length}`);
  for (const s of rows.slice(0, 10)) {
    console.log(
      `  ${s.snapshot_time} close=${s.close_snapshot} stock=${s.stock_price} opt=${s.option_price} iv=${s.current_iv} delta=${s.current_delta} theta=${s.current_theta}`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
