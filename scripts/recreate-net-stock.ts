// Recreate the NET stock_long row I deleted in error during the
// "ghost-row" cleanup. The deleted row had strike=0 (correct for
// stocks) and was misread as a phantom. Inserts a fresh stock_long
// row with the parameters the user specified, linking back to the
// assigned NET $205P parent put.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}
const sb = createClient(url, key);

const PARENT_ID_PREFIX = "efe28303";

async function main() {
  // Resolve the full parent UUID from the prefix.
  const parentLookup = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,status,position_type")
    .eq("symbol", "NET")
    .eq("strike", 205)
    .eq("status", "assigned");
  if (parentLookup.error) {
    console.error("parent lookup failed:", parentLookup.error.message);
    process.exit(1);
  }
  const candidates = (parentLookup.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    status: string;
    position_type: string | null;
  }>;
  const parent = candidates.find((p) => p.id.startsWith(PARENT_ID_PREFIX));
  if (!parent) {
    console.error(
      `no NET $205P parent matching prefix ${PARENT_ID_PREFIX}. candidates: ${JSON.stringify(candidates)}`,
    );
    process.exit(1);
  }
  console.log(`parent: ${parent.id} ${parent.symbol} $${parent.strike} exp=${parent.expiry}`);

  // Idempotent guard: bail if a stock_long row already points back to
  // this parent (avoid double-mint on re-run).
  const existing = await sb
    .from("positions")
    .select("id,symbol,total_contracts,entry_stock_price,status")
    .eq("assignment_source_id", parent.id)
    .eq("position_type", "stock_long");
  if (existing.error) {
    console.error("existing-row lookup failed:", existing.error.message);
    process.exit(1);
  }
  const already = existing.data ?? [];
  if (already.length > 0) {
    console.log(`stock_long already exists for parent ${parent.id}: ${JSON.stringify(already)}`);
    console.log("nothing to do.");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const insert = await sb
    .from("positions")
    .insert({
      symbol: "NET",
      strike: 0,
      expiry: today,
      option_type: "put",
      broker: "schwab",
      total_contracts: 300,
      avg_premium_sold: null,
      status: "open",
      opened_date: today,
      notes: "Assigned from NET $205P May 8",
      position_type: "stock_long",
      assignment_source_id: parent.id,
      entry_stock_price: 205,
    })
    .select()
    .single();
  if (insert.error || !insert.data) {
    console.error("insert failed:", insert.error?.message ?? "unknown");
    process.exit(1);
  }
  const row = insert.data as { id: string };
  console.log(`stock_long inserted: id=${row.id}`);

  const verify = await sb
    .from("positions")
    .select("id,symbol,position_type,total_contracts,entry_stock_price,assignment_source_id,status")
    .eq("id", row.id)
    .single();
  console.log(`verify: ${JSON.stringify(verify.data)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
