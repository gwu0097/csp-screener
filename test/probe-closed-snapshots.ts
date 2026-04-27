import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,status,closed_date,realized_pnl")
    .eq("status", "closed");
  const positions = (posRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    status: string;
    closed_date: string | null;
    realized_pnl: number | null;
  }>;
  console.log(`closed positions: ${positions.length}`);
  // Sort by closed_date desc for readability.
  positions.sort((a, b) =>
    (b.closed_date ?? "").localeCompare(a.closed_date ?? ""),
  );
  for (const p of positions.slice(0, 15)) {
    console.log(
      `  ${p.symbol.padEnd(6)} strike=${String(p.strike).padStart(6)} closed=${p.closed_date} pnl=${p.realized_pnl ?? "—"}`,
    );
  }

  if (positions.length === 0) return;

  const ids = positions.map((p) => p.id);
  const snapRes = await sb
    .from("position_snapshots")
    .select(
      "position_id,snapshot_time,close_snapshot,stock_price,option_price,current_iv,current_delta,pct_premium_remaining,move_ratio,actual_move_pct,days_since_entry",
    )
    .in("position_id", ids);
  const snaps = (snapRes.data ?? []) as Array<{
    position_id: string;
    snapshot_time: string | null;
    close_snapshot: boolean | null;
    stock_price: number | null;
    option_price: number | null;
    current_iv: number | null;
    current_delta: number | null;
    pct_premium_remaining: number | null;
    move_ratio: number | null;
    actual_move_pct: number | null;
    days_since_entry: number | null;
  }>;
  const posById = new Map(positions.map((p) => [p.id, p]));
  snaps.sort((a, b) => (b.snapshot_time ?? "").localeCompare(a.snapshot_time ?? ""));

  console.log(
    `\nsnapshots total=${snaps.length} (showing top 10 by snapshot_time desc)`,
  );
  console.log(
    "SYM    STRIKE  CLOSED_DATE  SNAPSHOT_TIME                CLOSE  STOCK    OPT     IV       DELTA    PREM_LEFT  MOVE_R  MOVE_PCT  DTE",
  );
  for (const s of snaps.slice(0, 10)) {
    const p = posById.get(s.position_id);
    const sym = (p?.symbol ?? "?").padEnd(6);
    const strike = String(p?.strike ?? "?").padStart(6);
    const closed = (p?.closed_date ?? "—").padEnd(11);
    const t = (s.snapshot_time ?? "—").padEnd(28);
    const flag = s.close_snapshot === true ? "TRUE " : s.close_snapshot === false ? "false" : "(null)";
    const stock = s.stock_price !== null ? s.stock_price.toFixed(2).padStart(7) : "     —";
    const opt = s.option_price !== null ? s.option_price.toFixed(2).padStart(6) : "     —";
    const iv = s.current_iv !== null ? s.current_iv.toFixed(4).padStart(7) : "      —";
    const delta = s.current_delta !== null ? s.current_delta.toFixed(4).padStart(7) : "      —";
    const left = s.pct_premium_remaining !== null ? s.pct_premium_remaining.toFixed(4).padStart(9) : "        —";
    const mr = s.move_ratio !== null ? s.move_ratio.toFixed(3).padStart(6) : "     —";
    const mp = s.actual_move_pct !== null ? s.actual_move_pct.toFixed(4).padStart(8) : "       —";
    const dte = s.days_since_entry !== null ? String(s.days_since_entry).padStart(3) : "  —";
    console.log(
      `${sym} ${strike}  ${closed} ${t} ${flag}  ${stock}  ${opt}  ${iv}  ${delta}  ${left}  ${mr}  ${mp}  ${dte}`,
    );
  }

  console.log(
    `\nsummary: close_snapshot=true: ${snaps.filter((s) => s.close_snapshot === true).length}, ` +
      `close_snapshot=false: ${snaps.filter((s) => s.close_snapshot === false).length}, ` +
      `IS NULL: ${snaps.filter((s) => s.close_snapshot === null).length}`,
  );
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
