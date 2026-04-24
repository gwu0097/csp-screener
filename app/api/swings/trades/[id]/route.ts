import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Deleting a trade can leave a kanban card in a trade-driven stage
// (ENTERED / EXITED) with no underlying trade to justify it. In that
// case we revert the linked idea back to CONVICTION so the user can
// decide the next step manually. If the idea still has other trades
// (partial un-delete), leave it alone.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const sb = createServerClient();

  // Capture the linked idea before deleting — the row goes away mid-request.
  const tradeRes = await sb
    .from("swing_trades")
    .select("swing_idea_id,symbol")
    .eq("id", id)
    .maybeSingle();
  if (tradeRes.error) {
    return NextResponse.json({ error: tradeRes.error.message }, { status: 400 });
  }
  const trade = tradeRes.data as { swing_idea_id: string | null; symbol: string } | null;
  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  const ideaId = trade.swing_idea_id;

  const del = await sb.from("swing_trades").delete().eq("id", id);
  if (del.error) {
    return NextResponse.json({ error: del.error.message }, { status: 400 });
  }

  let ideaReverted = false;
  if (ideaId) {
    // Any remaining trades under the same idea? limit(1) keeps the payload
    // small — we only need a 0/1+ answer.
    const remainingRes = await sb
      .from("swing_trades")
      .select("id")
      .eq("swing_idea_id", ideaId)
      .limit(1);
    if (remainingRes.error) {
      console.warn(
        `[swings/trades/delete] revert check failed for idea ${ideaId}: ${remainingRes.error.message}`,
      );
    } else {
      const remainingCount = Array.isArray(remainingRes.data)
        ? remainingRes.data.length
        : remainingRes.data
          ? 1
          : 0;
      if (remainingCount === 0) {
        const ideaRes = await sb
          .from("swing_ideas")
          .select("status")
          .eq("id", ideaId)
          .maybeSingle();
        const status = (ideaRes.data as { status: string } | null)?.status;
        if (status === "entered" || status === "exited") {
          const upd = await sb
            .from("swing_ideas")
            .update({
              status: "conviction",
              updated_at: new Date().toISOString(),
            })
            .eq("id", ideaId);
          if (upd.error) {
            console.warn(
              `[swings/trades/delete] idea revert failed for ${ideaId}: ${upd.error.message}`,
            );
          } else {
            ideaReverted = true;
          }
        }
      }
    }
  }

  return NextResponse.json({ ok: true, idea_reverted: ideaReverted });
}
