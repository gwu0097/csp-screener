import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const r = await sb
    .from("position_snapshots")
    .select("position_id,snapshot_time,stock_price,option_price,current_iv,current_delta,close_snapshot")
    .gte("snapshot_time", since)
    .order("snapshot_time", { ascending: false })
    .limit(20);
  const rows = (r.data ?? []) as Array<{
    position_id: string;
    snapshot_time: string;
    stock_price: number | null;
    option_price: number | null;
    current_iv: number | null;
    current_delta: number | null;
    close_snapshot: boolean;
  }>;
  console.log(`snapshots in last 5 min: ${rows.length}`);
  for (const s of rows) {
    console.log(
      `  ${s.snapshot_time.slice(11, 19)} ${s.position_id.slice(0, 8)} stock=${s.stock_price} opt=${s.option_price} iv=${s.current_iv?.toFixed(4)} δ=${s.current_delta} close=${s.close_snapshot}`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
