import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  const pos = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,status,total_contracts,avg_premium_sold,opened_date,closed_date,realized_pnl")
    .eq("symbol", "AXP");
  const rows = (pos.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    status: string;
    total_contracts: number;
    avg_premium_sold: number | null;
    opened_date: string | null;
    closed_date: string | null;
    realized_pnl: number | null;
  }>;
  console.log(`AXP positions: ${rows.length}`);
  for (const p of rows) {
    console.log(
      `  strike=${p.strike} expiry=${p.expiry} status=${p.status} contracts=${p.total_contracts} avg_premium=${p.avg_premium_sold} opened=${p.opened_date} closed=${p.closed_date} pnl=${p.realized_pnl ?? "—"}  id=${p.id}`,
    );
  }

  console.log("\nAXP fills:");
  const ids = rows.map((r) => r.id);
  const fills = await sb
    .from("fills")
    .select("id,position_id,fill_type,contracts,premium,fill_date,fill_time")
    .in("position_id", ids)
    .order("fill_time", { ascending: false });
  for (const f of (fills.data ?? []) as Array<{
    id: string;
    position_id: string;
    fill_type: string;
    contracts: number;
    premium: number;
    fill_date: string;
    fill_time: string;
  }>) {
    const parent = rows.find((r) => r.id === f.position_id);
    console.log(
      `  ${f.fill_date} ${f.fill_type.padEnd(5)} contracts=${f.contracts} @${f.premium}  → AXP ${parent?.strike} ${parent?.expiry}  fill_time=${f.fill_time}`,
    );
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
