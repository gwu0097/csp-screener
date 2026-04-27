import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  for (const t of ["positions", "fills", "trades", "market_context"]) {
    const { data, error } = await sb.from(t).select("id").limit(1);
    if (error) {
      console.log(`${t.padEnd(16)} → ERROR  ${error.message}`);
    } else {
      console.log(`${t.padEnd(16)} → EXISTS (sample rows=${data?.length ?? 0})`);
    }
  }
}
main().catch(console.error);
