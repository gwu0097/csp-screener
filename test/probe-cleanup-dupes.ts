import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  // ========== STEP 1: delete ghost positions (opened today, 0 contracts) ==========
  console.log("===== STEP 1: delete ghost positions + their fills =====");
  const ghostRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry")
    .eq("opened_date", "2026-04-23")
    .eq("total_contracts", 0);
  const ghosts = (ghostRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
  }>;
  console.log(`found ${ghosts.length} ghost positions:`);
  for (const g of ghosts) {
    console.log(`  ${g.symbol} ${g.strike} ${g.expiry}  id=${g.id}`);
  }

  if (ghosts.length > 0) {
    const ids = ghosts.map((g) => g.id);
    const delFills = await sb.from("fills").delete().in("position_id", ids);
    console.log(
      `  [fills delete] error=${delFills.error?.message ?? "none"}`,
    );
    const delPos = await sb
      .from("positions")
      .delete()
      .eq("opened_date", "2026-04-23")
      .eq("total_contracts", 0);
    console.log(
      `  [positions delete] error=${delPos.error?.message ?? "none"}`,
    );
  }

  // ========== STEP 2: normalize Sunday → Friday expiry on open positions ==========
  console.log("\n===== STEP 2: normalize 2026-04-26 → 2026-04-24 on open positions =====");
  const toUpdate = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,status")
    .eq("expiry", "2026-04-26")
    .eq("status", "open");
  const targets = (toUpdate.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    status: string;
  }>;
  console.log(`matched ${targets.length} open positions with expiry=2026-04-26:`);
  for (const t of targets) {
    console.log(`  ${t.symbol} ${t.strike} status=${t.status} id=${t.id}`);
  }
  if (targets.length > 0) {
    const updateRes = await sb
      .from("positions")
      .update({ expiry: "2026-04-24", updated_at: new Date().toISOString() })
      .eq("expiry", "2026-04-26")
      .eq("status", "open");
    console.log(`  [update] error=${updateRes.error?.message ?? "none"}`);
  }

  // ========== VERIFY ==========
  console.log("\n===== VERIFY: full positions table =====");
  const all = await sb
    .from("positions")
    .select("symbol,strike,expiry,status,opened_date,closed_date,total_contracts,realized_pnl,created_at");
  const rows = (all.data ?? []) as Array<{
    symbol: string;
    strike: number;
    expiry: string;
    status: string;
    opened_date: string | null;
    closed_date: string | null;
    total_contracts: number;
    realized_pnl: number | null;
    created_at: string | null;
  }>;
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  console.log(
    "SYM    STRIKE  EXPIRY      STATUS   OPENED      CLOSED      CTR  PNL",
  );
  for (const p of rows) {
    console.log(
      `${p.symbol.padEnd(6)} ${String(p.strike).padStart(6)}  ${p.expiry.padEnd(11)} ${p.status.padEnd(7)}  ${(p.opened_date ?? "—").padEnd(11)} ${(p.closed_date ?? "—").padEnd(11)} ${String(p.total_contracts).padStart(3)}  ${p.realized_pnl ?? "—"}`,
    );
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
