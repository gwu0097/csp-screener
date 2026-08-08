import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Local row shape — mirrors the one in ../route.ts (not imported cross-file,
// matching this codebase's existing convention of duplicating the type per
// route rather than sharing it).
type TradeRow = { id: string; [key: string]: unknown };

const EXIT_REASONS = [
  "stop_hit",
  "target_hit",
  "time_stop",
  "trailing_stop",
  "discretionary_override",
] as const;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(a: string, b: string): number {
  const start = new Date(a + "T00:00:00Z").getTime();
  const end = new Date(b + "T00:00:00Z").getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

type PatchBody = {
  // Close-the-trade path — all three required together, exit_reason must
  // be a deliberate selection (no default) since it's the field the whole
  // plan-vs-actual review depends on.
  exit_date?: unknown;
  exit_price?: unknown;
  exit_reason?: unknown;
  // Follow-up path — independent of the close path, usually submitted
  // weeks later via the follow-up prompt.
  price_two_weeks_after_exit?: unknown;
  exit_quality_note?: unknown;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sb = createServerClient();
  const isClosing =
    body.exit_date !== undefined ||
    body.exit_price !== undefined ||
    body.exit_reason !== undefined;
  const isFollowUp =
    body.price_two_weeks_after_exit !== undefined || body.exit_quality_note !== undefined;

  if (!isClosing && !isFollowUp) {
    return NextResponse.json({ error: "No recognized fields to update" }, { status: 400 });
  }
  if (isClosing && isFollowUp) {
    return NextResponse.json(
      { error: "Close and follow-up fields cannot be submitted together" },
      { status: 400 },
    );
  }

  if (isFollowUp) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.price_two_weeks_after_exit !== undefined) {
      patch.price_two_weeks_after_exit = num(body.price_two_weeks_after_exit);
    }
    if (body.exit_quality_note !== undefined) {
      patch.exit_quality_note =
        typeof body.exit_quality_note === "string" ? body.exit_quality_note.trim() || null : null;
    }
    const res = await sb
      .from<TradeRow>("swing_trades")
      .update(patch)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
    return NextResponse.json({ trade: res.data });
  }

  // Closing. exit_reason must be a real enum member — never defaulted —
  // since it's how "exited a winner early" or "widened a stop" becomes
  // visible at all.
  const exitDate = typeof body.exit_date === "string" ? body.exit_date : null;
  const exitPrice = num(body.exit_price);
  const exitReason =
    typeof body.exit_reason === "string" &&
    (EXIT_REASONS as readonly string[]).includes(body.exit_reason)
      ? body.exit_reason
      : null;
  if (!exitDate) return NextResponse.json({ error: "Missing exit_date" }, { status: 400 });
  if (exitPrice === null || exitPrice <= 0) {
    return NextResponse.json({ error: "exit_price must be > 0" }, { status: 400 });
  }
  if (!exitReason) {
    return NextResponse.json(
      { error: `exit_reason is required and must be one of: ${EXIT_REASONS.join(", ")}` },
      { status: 400 },
    );
  }

  const existingRes = await sb
    .from<TradeRow>("swing_trades")
    .select("entry_price,entry_date,shares,initial_risk_dollars,status")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingRes.error) {
    return NextResponse.json({ error: existingRes.error.message }, { status: 400 });
  }
  const existing = existingRes.data as
    | { entry_price: number; entry_date: string; shares: number; initial_risk_dollars: number; status: string }
    | null;
  if (!existing) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  if (existing.status === "closed") {
    return NextResponse.json({ error: "Trade is already closed" }, { status: 400 });
  }

  const realizedPnl = (exitPrice - existing.entry_price) * existing.shares;
  const rMultiple =
    existing.initial_risk_dollars > 0 ? realizedPnl / existing.initial_risk_dollars : null;
  const returnPct = existing.entry_price > 0 ? (exitPrice - existing.entry_price) / existing.entry_price : null;
  const daysHeld = daysBetween(existing.entry_date, exitDate);

  const res = await sb
    .from<TradeRow>("swing_trades")
    .update({
      exit_date: exitDate,
      exit_price: exitPrice,
      exit_reason: exitReason,
      realized_pnl: realizedPnl,
      r_multiple: rMultiple,
      return_pct: returnPct,
      days_held: daysHeld,
      status: "closed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
  return NextResponse.json({ trade: res.data });
}

// Deleting a trade can leave a kanban card in a trade-driven stage
// (ENTERED / EXITED) with no underlying trade to justify it. In that
// case we revert the linked idea back to CONVICTION so the user can
// decide the next step manually. If the idea still has other trades
// (partial un-delete), leave it alone.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const sb = createServerClient();

  // Capture the linked idea before deleting — the row goes away mid-request.
  const tradeRes = await sb
    .from("swing_trades")
    .select("swing_idea_id,symbol")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (tradeRes.error) {
    return NextResponse.json({ error: tradeRes.error.message }, { status: 400 });
  }
  const trade = tradeRes.data as { swing_idea_id: string | null; symbol: string } | null;
  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  const ideaId = trade.swing_idea_id;

  const del = await sb.from("swing_trades").delete().eq("id", id).eq("user_id", userId);
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
      .eq("user_id", userId)
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
          .eq("user_id", userId)
          .maybeSingle();
        const status = (ideaRes.data as { status: string } | null)?.status;
        if (status === "entered" || status === "exited") {
          const upd = await sb
            .from("swing_ideas")
            .update({
              status: "setup_ready",
              updated_at: new Date().toISOString(),
            })
            .eq("id", ideaId)
            .eq("user_id", userId);
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
