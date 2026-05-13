// Targeted shift: TSEM / NXT / ASTS close fills currently stored
// as 2026-05-12 should be 2026-05-13 under the new noon-based
// toEtDate convention. Five close fills total + their parent
// positions' closed_date.
//
// Default: print only. Pass `--apply` to write.

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

const APPLY = process.argv.includes("--apply");
const FROM = "2026-05-12";
const TO = "2026-05-13";
const SYMBOLS = ["TSEM", "NXT", "ASTS"];

async function main() {
  console.log(
    `Mode: ${APPLY ? "APPLY (writes will happen)" : "DRY RUN (print only)"}`,
  );
  console.log(
    `Shifting close fills (TSEM / NXT / ASTS) with fill_date=${FROM} → ${TO}\n`,
  );

  // Find the targeted positions.
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,closed_date,status,broker")
    .in("symbol", SYMBOLS);
  if (posRes.error) {
    console.error("positions query failed:", posRes.error.message);
    process.exit(1);
  }
  const allPos = (posRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    closed_date: string | null;
    status: string;
    broker: string;
  }>;
  const posById = new Map(allPos.map((p) => [p.id, p]));

  // Find their close fills currently at FROM.
  const positionIds = allPos.map((p) => p.id);
  const fillRes = await sb
    .from("fills")
    .select(
      "id,position_id,fill_type,contracts,premium,fill_date,created_at,import_batch_id",
    )
    .in("position_id", positionIds)
    .eq("fill_type", "close")
    .eq("fill_date", FROM);
  if (fillRes.error) {
    console.error("fills query failed:", fillRes.error.message);
    process.exit(1);
  }
  const fillCandidates = (fillRes.data ?? []) as Array<{
    id: string;
    position_id: string;
    fill_type: string;
    contracts: number;
    premium: number;
    fill_date: string;
    created_at: string;
    import_batch_id: string | null;
  }>;

  console.log(`=== Close fills to shift (${fillCandidates.length}) ===`);
  for (const f of fillCandidates) {
    const pos = posById.get(f.position_id);
    console.log(
      `  ${f.id.slice(0, 8)}…  ${pos?.symbol ?? "?"} $${pos?.strike ?? "?"} ${pos?.broker ?? "?"}  close ${f.contracts}@${f.premium}  fill_date=${f.fill_date}  created=${f.created_at}`,
    );
  }

  // Positions whose closed_date equals FROM and are in the target
  // symbol set — those followed the close fills' fill_date and need
  // the same shift.
  const closedCandidates = allPos.filter((p) => p.closed_date === FROM);
  console.log(
    `\n=== Positions w/ closed_date ${FROM} (${closedCandidates.length}) ===`,
  );
  for (const p of closedCandidates) {
    console.log(
      `  ${p.id.slice(0, 8)}…  ${p.symbol} $${p.strike} ${p.broker}  status=${p.status}  closed_date=${p.closed_date}`,
    );
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN complete. Would shift: ${fillCandidates.length} fills + ${closedCandidates.length} closed_date.`,
    );
    console.log("Re-run with --apply to write.");
    return;
  }

  console.log("\nApplying…");
  let okFills = 0;
  let okPos = 0;
  for (const f of fillCandidates) {
    const r = await sb.from("fills").update({ fill_date: TO }).eq("id", f.id);
    if (r.error) {
      console.error(`fill ${f.id} update failed: ${r.error.message}`);
      continue;
    }
    okFills += 1;
  }
  for (const p of closedCandidates) {
    const r = await sb
      .from("positions")
      .update({
        closed_date: TO,
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
    if (r.error) {
      console.error(`position ${p.id} closed_date update failed: ${r.error.message}`);
      continue;
    }
    okPos += 1;
  }
  console.log(`\nApplied: ${okFills} fills + ${okPos} closed_date.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
