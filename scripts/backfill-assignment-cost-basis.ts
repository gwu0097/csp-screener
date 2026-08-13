// Part 1 of the assignment P&L attribution fix: an assigned put today
// banks its full collected premium as realized_pnl on the OPTION row
// (via a synthetic $0 close — "Option A" accounting) while the stock
// leg it creates carries a raw strike cost basis. Neither row is
// interpretable alone. This backfill moves the premium onto the stock
// leg's cost basis instead, so the stock round-trip carries the whole
// economic result — matching the live-path fix now in
// mark-assigned/route.ts and create-from-assignment/route.ts.
//
// Scope: every OPTION row with status='assigned' that has a linked
// stock row via assignment_source_id. Per-share premium is read from
// avg_premium_sold (the option's own weighted-average opening
// premium, exact even across multi-fill scale-ins) and applied only to
// the shares the STOCK row's own open fill says were actually
// assigned — not the option's total_contracts, which over-counts when
// part of the position was bought back separately before assignment
// (observed once: ZS 8286279e, 2 contracts opened, 1 bought back at a
// loss, 1 assigned — only that 1 contract's premium belongs on the
// stock leg; the option keeps the buyback's own P&L). This makes the
// backfill exact for full assignments (option ends at $0) and correct
// for partial ones (option keeps its non-assignment P&L, only the
// assigned slice moves) without needing a separate skip case.
//
// NOT safely re-runnable by re-deriving state: avg_premium_sold is
// left untouched by design (it's the historical premium collected, not
// a running balance), so a second pass would try to move the same
// premium off the stock leg again. Guarded instead with an explicit
// notes marker (BACKFILL_TAG) written onto both rows after a successful
// pair — already-tagged options are skipped on any subsequent run.
//
//   npx tsx scripts/backfill-assignment-cost-basis.ts            → dry run
//   npx tsx scripts/backfill-assignment-cost-basis.ts --apply    → persists
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

const BACKFILL_TAG = "[cost-basis-backfilled]";

type OptionRow = {
  id: string;
  symbol: string;
  strike: string;
  avg_premium_sold: string | null;
  total_contracts: number;
  realized_pnl: string;
  campaign_id: string | null;
  notes: string | null;
};
type StockRow = {
  id: string;
  symbol: string;
  assignment_source_id: string;
  entry_stock_price: string | null;
  realized_pnl: string;
  status: string;
  campaign_id: string | null;
};

async function main() {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const { createServerClient } = await import("../lib/supabase");
  const { recalculatePositionFromFills } = await import("../lib/positions");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  const optRes = await sb
    .from("positions")
    .select("id,symbol,strike,avg_premium_sold,total_contracts,realized_pnl,campaign_id,notes")
    .eq("user_id", userId)
    .eq("status", "assigned")
    .eq("position_type", "option");
  const options = (optRes.data ?? []) as OptionRow[];

  const stockRes = await sb
    .from("positions")
    .select("id,symbol,assignment_source_id,entry_stock_price,realized_pnl,status,campaign_id")
    .eq("user_id", userId)
    .in(
      "assignment_source_id",
      options.map((o) => o.id),
    );
  const stocksBySource = new Map<string, StockRow>();
  for (const s of (stockRes.data ?? []) as StockRow[]) {
    stocksBySource.set(s.assignment_source_id, s);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let touched = 0;
  let skippedNoStock = 0;
  let skippedAlreadyTagged = 0;
  const rows: string[] = [];

  for (const o of options) {
    const stock = stocksBySource.get(o.id);
    if (!stock) {
      skippedNoStock++;
      rows.push(`  SKIP ${o.symbol} ${o.id}: no linked stock row (assignment_source_id)`);
      continue;
    }
    if ((o.notes ?? "").includes(BACKFILL_TAG)) {
      skippedAlreadyTagged++;
      rows.push(`  SKIP ${o.symbol} ${o.id}: already backfilled (notes tag present)`);
      continue;
    }
    const avgPremium = o.avg_premium_sold !== null ? Number(o.avg_premium_sold) : 0;
    const optionPnlBefore = Number(o.realized_pnl);
    const stockBefore = Number(stock.realized_pnl);
    totalBefore += optionPnlBefore + stockBefore;

    // 1. Find the stock leg's open fill — its own contracts count is
    // the true assigned-share count (may be less than the option's
    // total_contracts if part of the position was bought back
    // separately before assignment).
    const fillsRes = await sb
      .from("fills")
      .select("id,fill_type,premium,contracts")
      .eq("position_id", stock.id)
      .eq("fill_type", "open");
    const openFills = (fillsRes.data ?? []) as Array<{
      id: string;
      fill_type: string;
      premium: string;
      contracts: number;
    }>;
    if (openFills.length !== 1) {
      console.warn(
        `  ABORT ${o.symbol} ${stock.id}: expected exactly 1 open fill, found ${openFills.length} — skipping, needs manual review`,
      );
      continue;
    }
    const assignedShares = openFills[0].contracts;
    const premiumMoved = Math.round(avgPremium * assignedShares * 100) / 100;
    const oldFillPremium = Number(openFills[0].premium);
    // 4dp, matching avg_premium_sold's own precision — rounding to
    // cents here silently drops sub-cent-per-share drift that then
    // compounds across hundreds of shares (observed: $1 error on a
    // 200-share lot from a single half-cent-per-share truncation).
    const newFillPremium = Math.round((oldFillPremium - avgPremium) * 10000) / 10000;
    const optionPnlAfter = Math.round((optionPnlBefore - premiumMoved) * 100) / 100;

    if (!apply) {
      const stockAfterEstimate = stockBefore + premiumMoved;
      totalAfter += optionPnlAfter + stockAfterEstimate;
      rows.push(
        `  ${o.symbol} ${o.id.slice(0, 8)}: option ${optionPnlBefore.toFixed(2)} -> ${optionPnlAfter.toFixed(2)}, ` +
          `stock ${stockBefore.toFixed(2)} -> ~${stockAfterEstimate.toFixed(2)} ` +
          `(${assignedShares} sh, cost basis -${avgPremium.toFixed(4)}/share, premium moved ${premiumMoved.toFixed(2)})`,
      );
      touched++;
      continue;
    }

    const fillUpd = await sb
      .from("fills")
      .update({ premium: newFillPremium })
      .eq("id", openFills[0].id);
    if (fillUpd.error) {
      console.error(`  ERROR updating fill for ${stock.id}: ${fillUpd.error.message}`);
      continue;
    }

    const optUpd = await sb
      .from("positions")
      .update({
        realized_pnl: optionPnlAfter,
        notes: o.notes ? `${o.notes} | ${BACKFILL_TAG}` : BACKFILL_TAG,
        updated_at: new Date().toISOString(),
      })
      .eq("id", o.id);
    if (optUpd.error) {
      console.error(`  ERROR updating option ${o.id}: ${optUpd.error.message}`);
      continue;
    }

    // Recalc the stock leg from its fill ledger (same code path as
    // every live write) — regenerates realized_pnl, entry_stock_price
    // stays a display cache updated separately below.
    const recalc = await recalculatePositionFromFills(stock.id, sb);
    if (!recalc.ok) {
      console.error(`  ERROR recalculating stock ${stock.id}: ${recalc.error}`);
      continue;
    }
    await sb
      .from("positions")
      .update({ entry_stock_price: newFillPremium })
      .eq("id", stock.id);

    const afterRes = await sb
      .from("positions")
      .select("realized_pnl")
      .eq("id", stock.id)
      .single();
    const stockAfter = Number((afterRes.data as { realized_pnl: string } | null)?.realized_pnl ?? 0);
    totalAfter += optionPnlAfter + stockAfter;
    touched++;
    rows.push(
      `  ${o.symbol} ${o.id.slice(0, 8)}: option ${optionPnlBefore.toFixed(2)} -> ${optionPnlAfter.toFixed(2)}, ` +
        `stock ${stockBefore.toFixed(2)} -> ${stockAfter.toFixed(2)} (expected ${(stockBefore + premiumMoved).toFixed(2)})`,
    );
    if (Math.abs(stockAfter - (stockBefore + premiumMoved)) > 0.01) {
      console.warn(
        `  WARNING: recalculated stock P&L diverges from the expected invariant sum for ${stock.id}`,
      );
    }
  }

  console.log(apply ? "=== APPLY ===" : "=== DRY RUN (pass --apply to persist) ===");
  console.log(rows.join("\n"));
  console.log(`\npairs touched: ${touched}`);
  console.log(`skipped (no linked stock): ${skippedNoStock}`);
  console.log(`skipped (already tagged): ${skippedAlreadyTagged}`);
  console.log(`sum(option_pnl + stock_pnl) before: ${totalBefore.toFixed(2)}`);
  console.log(`sum(option_pnl + stock_pnl) after:  ${totalAfter.toFixed(2)}`);
  console.log(`delta: ${(totalAfter - totalBefore).toFixed(2)} (must be 0.00)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
