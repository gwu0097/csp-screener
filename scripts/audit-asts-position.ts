// Pull open ASTS positions + verify Schwab has a May 22 expiry on
// the chain. Read-only.

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
  console.log("=== Stored ASTS open positions ===");
  const r = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,option_type,total_contracts,avg_premium_sold,broker,status,opened_date",
    )
    .eq("symbol", "ASTS")
    .eq("status", "open");
  for (const p of r.data ?? []) console.log("  " + JSON.stringify(p));

  console.log("\n=== Schwab chain for ASTS ===");
  const { getOptionsChainWide } = await import("../lib/schwab");
  const chain = await getOptionsChainWide("ASTS", "2026-05-22", 7);
  if (!chain) {
    console.log("chain: null (fetch failed)");
    return;
  }
  console.log(`underlying: $${chain.underlying?.mark ?? chain.underlying?.last ?? "?"}`);
  console.log(
    `putExpDateMap keys: ${Object.keys(chain.putExpDateMap ?? {}).join(", ")}`,
  );
  const keys = Object.keys(chain.putExpDateMap ?? {});
  const may22Key = keys.find((k) => k.startsWith("2026-05-22"));
  if (may22Key) {
    const strikes = chain.putExpDateMap[may22Key];
    const sorted = Object.keys(strikes).map(Number).sort((a, b) => a - b);
    console.log(`\nASTS has 2026-05-22 expiry. strikes: ${sorted.join(", ")}`);
    // The user mentioned ASTS $57P specifically — check it.
    const wanted = strikes["57"] ?? strikes["57.00"] ?? null;
    if (wanted && wanted.length > 0) {
      const c = wanted[0];
      console.log(
        `  $57P May 22: mark=${c.mark}  bid=${c.bid}  ask=${c.ask}  delta=${c.delta}`,
      );
    } else {
      console.log(`  $57 strike not present at May 22`);
    }
  } else {
    console.log(`No 2026-05-22 expiry on ASTS. Nearest: ${keys.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
