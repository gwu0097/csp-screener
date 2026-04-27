import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,status")
    .in("symbol", ["AXP", "TSLA"]);
  if (posRes.error) {
    console.log("positions error:", posRes.error.message);
    return;
  }
  const positions = (posRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    status: string;
  }>;
  console.log(`positions found for AXP/TSLA: ${positions.length}`);
  for (const p of positions) {
    console.log(`  ${p.symbol} strike=${p.strike} status=${p.status} id=${p.id}`);
  }
  if (positions.length === 0) {
    console.log("\n(no AXP or TSLA positions in table — nothing to snapshot)");
    return;
  }

  const ids = positions.map((p) => p.id);
  const snapRes = await sb
    .from("position_snapshots")
    .select(
      "position_id,snapshot_time,close_snapshot,stock_price,option_price,current_iv,current_delta,pct_premium_remaining,move_ratio",
    )
    .in("position_id", ids);
  if (snapRes.error) {
    console.log("\nsnapshots error:", snapRes.error.message);
    return;
  }
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
  }>;
  const posById = new Map(positions.map((p) => [p.id, p]));

  snaps.sort((a, b) =>
    (b.snapshot_time ?? "").localeCompare(a.snapshot_time ?? ""),
  );

  console.log(
    `\nsnapshots total=${snaps.length} (showing top 10 by snapshot_time desc)`,
  );
  console.log(
    "SYM  STRIKE  STATUS   SNAPSHOT_TIME                CLOSE  STOCK     OPT     IV       DELTA    PREM_LEFT  MOVE_RATIO",
  );
  for (const s of snaps.slice(0, 10)) {
    const p = posById.get(s.position_id);
    const sym = (p?.symbol ?? "?").padEnd(4);
    const strike = String(p?.strike ?? "?").padStart(6);
    const status = (p?.status ?? "?").padEnd(7);
    const t = (s.snapshot_time ?? "—").padEnd(28);
    const closeFlag = s.close_snapshot === null ? "(null)" : s.close_snapshot ? "TRUE " : "false";
    const stock = s.stock_price !== null ? s.stock_price.toFixed(2).padStart(7) : "     —";
    const opt = s.option_price !== null ? s.option_price.toFixed(2).padStart(6) : "     —";
    const iv = s.current_iv !== null ? s.current_iv.toFixed(4).padStart(7) : "      —";
    const delta = s.current_delta !== null ? s.current_delta.toFixed(4).padStart(7) : "      —";
    const left =
      s.pct_premium_remaining !== null ? s.pct_premium_remaining.toFixed(4).padStart(9) : "        —";
    const mr = s.move_ratio !== null ? s.move_ratio.toFixed(4).padStart(9) : "        —";
    console.log(
      `${sym} ${strike}  ${status}  ${t} ${closeFlag}  ${stock}  ${opt}  ${iv}  ${delta}  ${left}  ${mr}`,
    );
  }

  const closeCount = snaps.filter((s) => s.close_snapshot === true).length;
  const intradayCount = snaps.filter((s) => s.close_snapshot === false).length;
  const nullCount = snaps.filter((s) => s.close_snapshot === null).length;
  console.log(
    `\nsummary: close_snapshot=true: ${closeCount}, close_snapshot=false: ${intradayCount}, close_snapshot IS NULL: ${nullCount}`,
  );
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
