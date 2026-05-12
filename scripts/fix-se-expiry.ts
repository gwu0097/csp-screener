// One-shot: correct the SE $64P expiry from 2026-05-26 (Tuesday,
// not a listed Schwab weekly) to 2026-05-22 (the actual Friday).
// Shows the row before + after so the change is visible in stdout.

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

async function main() {
  console.log("=== Before ===");
  const before = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,broker,status,total_contracts,avg_premium_sold")
    .eq("symbol", "SE")
    .eq("strike", 64)
    .eq("expiry", "2026-05-26")
    .eq("broker", "schwab")
    .eq("status", "open");
  if (before.error) {
    console.error("scan failed:", before.error.message);
    process.exit(1);
  }
  const rows = before.data ?? [];
  console.log(`matched ${rows.length} row(s):`);
  for (const r of rows) console.log("  " + JSON.stringify(r));
  if (rows.length === 0) {
    console.log("nothing to update.");
    return;
  }
  if (rows.length > 1) {
    console.error("refusing to update — more than one match. Review manually.");
    process.exit(1);
  }

  const id = rows[0].id;
  const upd = await sb
    .from("positions")
    .update({
      expiry: "2026-05-22",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (upd.error) {
    console.error("update failed:", upd.error.message);
    process.exit(1);
  }
  console.log(`\nupdate applied to id=${id}: expiry 2026-05-26 → 2026-05-22`);

  console.log("\n=== After ===");
  const after = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,broker,status,total_contracts,avg_premium_sold")
    .eq("id", id)
    .single();
  if (after.error) {
    console.error("verify failed:", after.error.message);
    process.exit(1);
  }
  console.log("  " + JSON.stringify(after.data));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
