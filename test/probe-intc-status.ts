import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  const r = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,status,closed_date")
    .eq("symbol", "INTC");
  const rows = (r.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    status: string;
    closed_date: string | null;
  }>;
  for (const p of rows)
    console.log(`  ${p.id.slice(0, 8)} ${p.symbol} ${p.strike} exp=${p.expiry} status=${p.status} closed=${p.closed_date}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
