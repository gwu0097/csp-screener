// One-shot fix for the phantom NET row created during the
// assignment-flow refactor: symbol=NET, strike=0 OR total_contracts=0,
// status='open'. Scans, prints, then deletes the row(s) plus
// dependent fills + position_snapshots. No-op if nothing matches.

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
  const r = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,total_contracts,status,realized_pnl,created_at")
    .eq("symbol", "NET")
    .eq("status", "open")
    .or("strike.eq.0,total_contracts.eq.0");
  if (r.error) {
    console.error("scan failed:", r.error.message);
    process.exit(1);
  }
  const rows = r.data ?? [];
  console.log(`ghost NET rows matched: ${rows.length}`);
  for (const p of rows) {
    console.log(
      `  ${p.created_at} id=${p.id} ${p.symbol} strike=${p.strike} expiry=${p.expiry} contracts=${p.total_contracts} status=${p.status} pnl=${p.realized_pnl}`,
    );
  }
  if (rows.length === 0) {
    console.log("nothing to do.");
    return;
  }

  const ids = rows.map((p) => p.id);

  const sn = await sb
    .from("position_snapshots")
    .delete({ count: "exact" })
    .in("position_id", ids);
  console.log(
    `position_snapshots deleted: ${sn.count ?? 0}${sn.error ? " (ERROR " + sn.error.message + ")" : ""}`,
  );
  if (sn.error) process.exit(1);

  const fl = await sb.from("fills").delete({ count: "exact" }).in("position_id", ids);
  console.log(
    `fills deleted: ${fl.count ?? 0}${fl.error ? " (ERROR " + fl.error.message + ")" : ""}`,
  );
  if (fl.error) process.exit(1);

  const ps = await sb.from("positions").delete({ count: "exact" }).in("id", ids);
  console.log(
    `positions deleted: ${ps.count ?? 0}${ps.error ? " (ERROR " + ps.error.message + ")" : ""}`,
  );
  if (ps.error) process.exit(1);

  const verify = await sb.from("positions").select("id").in("id", ids);
  console.log(
    `verify: ${(verify.data ?? []).length} of ${ids.length} positions still present (should be 0)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
