// Applies the two confirmed 2026-07-28 import-audit data corrections.
// Backup tables (backup_20260728_glw_phantom_be_premium_positions/fills)
// must already exist — see migrations/2026-07-28-glw-phantom-be-premium-fix-backup.sql.
//
// 1. Delete the GLW $100P phantom (2f771a3d...) — a hallucinated duplicate
//    of the real UPS $100P/3-contract close (eb0dc8ba..., left untouched).
//    No corresponding broker row exists.
// 2. Correct the three BE $90P close fills on ded8591e... from $0.0000 to
//    $0.24 (the per-leg price the ledger prints; the CREDIT/DEBIT
//    net-summary bug zeroed them). Then run recalculatePositionFromFills()
//    — the real app function — so realized_pnl/status reflect the fix.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function loadEnvLocal(): void {
  try {
    const c = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const raw of c.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("="); if (eq === -1) continue;
      const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnvLocal();
import { createClient } from "@supabase/supabase-js";
import { recalculatePositionFromFills } from "@/lib/positions";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const GLW_PHANTOM_ID = "2f771a3d-f134-43e5-bf10-3042575519e4";
const BE_90P_ID = "ded8591e-65e3-4d3a-a7b1-c28481ea8f6c";
const ZERO_FILL_IDS = [
  "a2c5f1ac-e3b1-4b5b-a2af-e5097a015a3f", // close, 2 contracts, 20:04:47.146
  "0a9b6340-1c01-4d61-b7e7-ac4c28546c72", // close, 1 contract,  20:04:47.566
  "96bb6336-7abf-461c-8f63-254215ceadc4", // close, 2 contracts, 20:04:47.958
];

async function main() {
  console.log("=== BEFORE ===");
  const glwBefore = await sb.from("positions").select("*").eq("id", GLW_PHANTOM_ID).maybeSingle();
  console.log("GLW phantom position:", glwBefore.data);
  const beBefore = await sb.from("positions").select("id,symbol,strike,status,total_contracts,avg_premium_sold,realized_pnl").eq("id", BE_90P_ID).single();
  console.log("BE 90P position:", beBefore.data);
  const beFillsBefore = await sb.from("fills").select("id,fill_type,contracts,premium,fill_time").eq("position_id", BE_90P_ID).order("fill_time");
  console.log("BE 90P fills:", beFillsBefore.data);

  // --- Fix 1: delete GLW phantom ---
  console.log("\n=== Deleting GLW phantom ===");
  const delFills = await sb.from("fills").delete().eq("position_id", GLW_PHANTOM_ID);
  if (delFills.error) throw new Error(`delete GLW fills failed: ${delFills.error.message}`);
  const delPos = await sb.from("positions").delete().eq("id", GLW_PHANTOM_ID);
  if (delPos.error) throw new Error(`delete GLW position failed: ${delPos.error.message}`);
  console.log("GLW phantom deleted.");

  // --- Fix 2: correct BE 90P close premiums, then recalc ---
  console.log("\n=== Correcting BE 90P close premiums ===");
  for (const id of ZERO_FILL_IDS) {
    const upd = await sb
      .from("fills")
      .update({ premium: 0.24 })
      .eq("id", id)
      .eq("position_id", BE_90P_ID)
      .eq("premium", 0);
    if (upd.error) throw new Error(`update fill ${id} failed: ${upd.error.message}`);
  }
  console.log("Fills updated. Recalculating position aggregates...");
  const recalc = await recalculatePositionFromFills(BE_90P_ID, sb);
  console.log("recalculatePositionFromFills result:", recalc);

  console.log("\n=== AFTER ===");
  const glwAfter = await sb.from("positions").select("id").eq("id", GLW_PHANTOM_ID).maybeSingle();
  console.log("GLW phantom position (should be null):", glwAfter.data);
  const beAfter = await sb.from("positions").select("id,symbol,strike,status,total_contracts,avg_premium_sold,realized_pnl").eq("id", BE_90P_ID).single();
  console.log("BE 90P position:", beAfter.data);
  const beFillsAfter = await sb.from("fills").select("id,fill_type,contracts,premium,fill_time").eq("position_id", BE_90P_ID).order("fill_time");
  console.log("BE 90P fills:", beFillsAfter.data);

  const upsCheck = await sb.from("positions").select("id,symbol,strike,status,total_contracts,avg_premium_sold").eq("symbol", "UPS").order("created_at", { ascending: false });
  console.log("\nUPS positions (should be unchanged, 2 rows):", upsCheck.data);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
