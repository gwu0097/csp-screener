// Flip the two known-long ZS calls to direction='long' and recompute
// realized_pnl with the corrected sign. Run AFTER the migration in
// migrations/2026-05-30-add-positions-direction.sql has been applied.
// Pass --apply to actually write.
//
// Targets:
//   ZS $135C 2026-06-05  (id prefix f3467714) — open w/ partial closes
//   ZS $138C 2026-05-29  (id prefix fadd08c6) — fully closed

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
import {
  realizedPnl,
  avgPremiumSold,
  remainingContracts,
  type Fill,
} from "../lib/positions";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}
const sb = createClient(url, key);

const APPLY = process.argv.includes("--apply");
const TARGETS = [
  { idPrefix: "f3467714", symbol: "ZS", strike: 135, expiry: "2026-06-05" },
  { idPrefix: "fadd08c6", symbol: "ZS", strike: 138, expiry: "2026-05-29" },
];

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  for (const t of TARGETS) {
    const lookup = await sb
      .from("positions")
      .select(
        "id,symbol,strike,expiry,option_type,direction,total_contracts,avg_premium_sold,realized_pnl,status,closed_date",
      )
      .eq("symbol", t.symbol)
      .eq("strike", t.strike)
      .eq("expiry", t.expiry)
      .eq("broker", "robinhood");
    if (lookup.error) {
      console.error(`${t.symbol} lookup failed: ${lookup.error.message}`);
      continue;
    }
    const rows = (lookup.data ?? []) as Array<{
      id: string;
      symbol: string;
      strike: number;
      expiry: string;
      option_type: string | null;
      direction: string | null;
      total_contracts: number | null;
      avg_premium_sold: number | null;
      realized_pnl: number | null;
      status: string;
      closed_date: string | null;
    }>;
    const pos = rows.find((r) => r.id.startsWith(t.idPrefix));
    if (!pos) {
      console.log(`${t.symbol} $${t.strike}C — no row matching prefix ${t.idPrefix}, skipping`);
      continue;
    }

    console.log(`\n${t.symbol} $${t.strike}C ${t.expiry}  (id=${pos.id})`);
    console.log(
      `  BEFORE: option_type=${pos.option_type}  direction=${pos.direction}  realized=${fmt(pos.realized_pnl !== null ? Number(pos.realized_pnl) : null)}  status=${pos.status}`,
    );

    const fillsRes = await sb
      .from("fills")
      .select("fill_type,contracts,premium,fill_date")
      .eq("position_id", pos.id);
    const fills = (fillsRes.data ?? []) as Fill[];
    const recomputed = Math.round(realizedPnl(fills, "long") * 100) / 100;
    const sold = avgPremiumSold(fills);
    const totalOpened = fills
      .filter((f) => f.fill_type === "open")
      .reduce((s, f) => s + f.contracts, 0);
    const remaining = remainingContracts(fills);
    const status: "open" | "closed" =
      remaining === 0 && totalOpened > 0 ? "closed" : "open";
    const closedDate =
      status === "closed"
        ? fills
            .filter((f) => f.fill_type === "close")
            .map((f) => f.fill_date)
            .sort()
            .pop() ?? null
        : null;

    console.log(
      `  RECOMPUTE (direction='long'): realized=${fmt(recomputed)}  avg_sold=${fmt(sold)}  total_opened=${totalOpened}  remaining=${remaining}  status=${status}  closed_date=${closedDate}`,
    );

    if (!APPLY) {
      console.log("  (dry-run — no write)");
      continue;
    }
    const upd = await sb
      .from("positions")
      .update({
        direction: "long",
        realized_pnl: recomputed,
        total_contracts: totalOpened,
        avg_premium_sold: totalOpened > 0 ? sold : null,
        status,
        closed_date: closedDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pos.id);
    if (upd.error) {
      console.error(`  UPDATE FAILED: ${upd.error.message}`);
      console.error(
        `  (If the error is "column 'direction' does not exist", run migrations/2026-05-30-add-positions-direction.sql in Supabase first.)`,
      );
      continue;
    }
    console.log("  APPLIED.");
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
