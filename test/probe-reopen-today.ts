import { createServerClient } from "../lib/supabase";

const TARGET_DATE = "2026-04-23";

async function main() {
  const sb = createServerClient();

  // Dry-run preview before mutating.
  const posBefore = await sb
    .from("positions")
    .select("id,symbol,strike,status,closed_date,realized_pnl")
    .eq("closed_date", TARGET_DATE);
  console.log(
    `[before] positions with closed_date=${TARGET_DATE}: ${posBefore.data?.length ?? 0}`,
  );

  const fillsBefore = await sb
    .from("fills")
    .select("id,position_id,contracts,premium,fill_date")
    .eq("fill_type", "close")
    .eq("fill_date", TARGET_DATE);
  console.log(
    `[before] close fills on ${TARGET_DATE}: ${fillsBefore.data?.length ?? 0}`,
  );

  // 1. Reopen positions.
  const updateRes = await sb
    .from("positions")
    .update({
      status: "open",
      closed_date: null,
      realized_pnl: null,
      updated_at: new Date().toISOString(),
    })
    .eq("closed_date", TARGET_DATE);
  console.log(
    `\n[update] error=${updateRes.error?.message ?? "none"} (closed_date=${TARGET_DATE} → status=open, closed_date=NULL, realized_pnl=NULL)`,
  );

  // 2. Delete close fills from that date.
  const deleteRes = await sb
    .from("fills")
    .delete()
    .eq("fill_type", "close")
    .eq("fill_date", TARGET_DATE);
  console.log(
    `[delete] error=${deleteRes.error?.message ?? "none"} (fill_type=close AND fill_date=${TARGET_DATE})`,
  );

  // 3. Verify.
  console.log("\n[verify] all positions, newest first:");
  const verify = await sb
    .from("positions")
    .select("symbol,strike,status,closed_date,realized_pnl,created_at");
  const rows = (verify.data ?? []) as Array<{
    symbol: string;
    strike: number;
    status: string;
    closed_date: string | null;
    realized_pnl: number | null;
    created_at: string | null;
  }>;
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  console.log("SYM    STRIKE  STATUS  CLOSED      PNL");
  for (const p of rows) {
    console.log(
      `${p.symbol.padEnd(6)} ${String(p.strike).padStart(6)}  ${p.status.padEnd(7)} ${(p.closed_date ?? "—").padEnd(11)} ${String(p.realized_pnl ?? "—").padStart(6)}`,
    );
  }

  const stillClosed = await sb
    .from("fills")
    .select("id")
    .eq("fill_type", "close")
    .eq("fill_date", TARGET_DATE);
  console.log(
    `\n[verify] remaining close fills on ${TARGET_DATE}: ${stillClosed.data?.length ?? 0}`,
  );
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
