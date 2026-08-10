import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { recordExitFill } from "@/lib/swing-trade-fills";

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

type PatchBody = {
  // Exit path — a full close or a partial sell, same mechanism either
  // way. shares defaults to the position's full open_shares when
  // omitted, matching the old all-or-nothing behavior for callers that
  // don't send it. exit_reason must be a deliberate selection (no
  // default) since it's the field the whole plan-vs-actual review
  // depends on.
  shares?: unknown;
  exit_date?: unknown;
  exit_price?: unknown;
  exit_reason?: unknown;
  // Trail-stop path — updates the mutable current_stop only. Never
  // touches initial_stop, so it can never move an already-recorded R.
  current_stop?: unknown;
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
    body.shares !== undefined || body.exit_date !== undefined ||
    body.exit_price !== undefined || body.exit_reason !== undefined;
  const isTrailingStop = body.current_stop !== undefined;
  const isFollowUp =
    body.price_two_weeks_after_exit !== undefined || body.exit_quality_note !== undefined;

  const modes = [isClosing, isTrailingStop, isFollowUp].filter(Boolean).length;
  if (modes === 0) {
    return NextResponse.json({ error: "No recognized fields to update" }, { status: 400 });
  }
  if (modes > 1) {
    return NextResponse.json(
      { error: "Exit, trail-stop, and follow-up fields cannot be submitted together" },
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

  if (isTrailingStop) {
    const newStop = num(body.current_stop);
    if (newStop === null || newStop <= 0) {
      return NextResponse.json({ error: "current_stop must be > 0" }, { status: 400 });
    }
    const res = await sb
      .from<TradeRow>("swing_trades")
      .update({ current_stop: newStop, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
    return NextResponse.json({ trade: res.data });
  }

  // Closing / partial sell. exit_reason must be a real enum member —
  // never defaulted — since it's how "exited a winner early" or
  // "widened a stop" becomes visible at all.
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
    .select("id,user_id,entry_date,initial_risk_dollars,open_shares,broker")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingRes.error) {
    return NextResponse.json({ error: existingRes.error.message }, { status: 400 });
  }
  const existing = existingRes.data as
    | {
        id: string;
        user_id: string;
        entry_date: string;
        initial_risk_dollars: number;
        open_shares: number;
        broker: string | null;
      }
    | null;
  if (!existing) return NextResponse.json({ error: "Trade not found" }, { status: 404 });

  // shares defaults to the full (cached) open amount when omitted —
  // recordExitFill re-derives true capacity from the fills themselves
  // before allocating, so a stale cache here just means the default
  // guess might be off; it can't cause an over-sell.
  const sharesToSell = body.shares !== undefined ? num(body.shares) : existing.open_shares;
  if (sharesToSell === null || sharesToSell <= 0) {
    return NextResponse.json({ error: "shares must be > 0" }, { status: 400 });
  }

  const result = await recordExitFill(
    sb,
    { id: existing.id, user_id: existing.user_id, entry_date: existing.entry_date, initial_risk_dollars: existing.initial_risk_dollars },
    { shares: sharesToSell, price: exitPrice, date: exitDate, exitReason, broker: existing.broker },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ trade: result.trade, fill: result.fill });
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
