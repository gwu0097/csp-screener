import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { buildStampContext, stampEntryContext } from "@/lib/entry-context";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Hard-delete a single position by id. Used by the position card's
// inline Remove control to clean up bad imports (broker screenshots
// that produced wrong strikes, accidental duplicate entries).
//
// fills / position_snapshots / post_earnings_recommendations all
// reference positions.id; we don't know whether the schema has
// ON DELETE CASCADE wired, so we clear the children explicitly. None
// of those child writes is fatal — if a delete fails we still
// attempt the parent and surface the first error.
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
  const id = params.id;
  if (!id || typeof id !== "string") {
    return NextResponse.json(
      { success: false, error: "id required" },
      { status: 400 },
    );
  }

  const sb = createServerClient();

  // Existence check — return 404 instead of silently no-op'ing so the
  // client can distinguish "stale list" from "delete actually ran".
  const exists = await sb
    .from("positions")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .limit(1);
  if (exists.error) {
    return NextResponse.json(
      { success: false, error: exists.error.message },
      { status: 500 },
    );
  }
  if (!exists.data || (exists.data as Array<unknown>).length === 0) {
    return NextResponse.json(
      { success: false, error: "position not found" },
      { status: 404 },
    );
  }

  for (const table of [
    "fills",
    "position_snapshots",
    "post_earnings_recommendations",
  ]) {
    const r = await sb
      .from(table)
      .delete()
      .eq("position_id", id)
      .eq("user_id", userId);
    if (r.error) {
      console.warn(
        `[positions/delete] child cleanup ${table} for ${id} failed: ${r.error.message}`,
      );
    }
  }

  const del = await sb
    .from("positions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (del.error) {
    return NextResponse.json(
      { success: false, error: del.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, id });
}

type ContractPatchBody = {
  strike?: unknown;
  expiry?: unknown;
  optionType?: unknown;
  broker?: unknown;
};

// Same set the manual-import modal offers — see components/import-
// manual-modal.tsx's BROKERS constant. Kept as a literal copy rather
// than a shared import: this route only needs the list for
// validation, not the display-label mapping that comes with it.
const VALID_BROKERS = ["schwab", "schwab2", "robinhood", "covered_calls", "fidelity", "other"] as const;

// Corrects a position's own contract attributes (strike, expiry, option
// type) — distinct from Edit Fills, which only touches the fills ledger.
// A position imported or entered with the wrong strike previously had no
// fix short of delete-and-rebuild, which loses its fills and entry
// context. mark/P&L/POP/%OTM/IV/delta/theta/DTE and the status badge are
// all computed at READ time in /api/positions/open straight off these
// columns (see runStageFour-equivalent pipeline there) — no cache to
// invalidate, the very next fetch reflects the corrected contract.
//
// entry_stock_price / entry_em_pct / entry_vix are stock-level,
// time-of-entry facts — untouched regardless of which strike was
// recorded, per instruction. entry_iv / entry_delta / entry_dte ARE
// strike-specific historical snapshots (fetched for the ORIGINAL,
// possibly-wrong contract) — nulled here and best-effort re-stamped from
// a fresh chain lookup against the corrected contract via the same
// stampEntryContext used on import (fills-null-only, never overwrites).
//
// Deliberately does NOT pre-check for a colliding (symbol, strike,
// expiry, broker) row: two option positions sharing that key are a
// legitimate, expected outcome of a correction (see the
// 2026-07-23-relax-positions-options-unique migration) and must not be
// merged — they carry different entry prices and different stamped
// entry context.
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
  const id = params.id;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  let body: ContractPatchBody;
  try {
    body = (await req.json()) as ContractPatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const hasStrike = body.strike !== undefined;
  const hasExpiry = body.expiry !== undefined;
  const hasOptionType = body.optionType !== undefined;
  const hasBroker = body.broker !== undefined;
  if (!hasStrike && !hasExpiry && !hasOptionType && !hasBroker) {
    return NextResponse.json(
      { error: "At least one of strike, expiry, optionType, broker is required" },
      { status: 400 },
    );
  }

  let newStrike: number | null = null;
  if (hasStrike) {
    const n = Number(body.strike);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { error: "strike must be a positive number" },
        { status: 400 },
      );
    }
    newStrike = n;
  }

  let newExpiry: string | null = null;
  if (hasExpiry) {
    if (
      typeof body.expiry !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.expiry)
    ) {
      return NextResponse.json(
        { error: "expiry must be YYYY-MM-DD" },
        { status: 400 },
      );
    }
    newExpiry = body.expiry;
  }

  let newOptionType: "put" | "call" | null = null;
  if (hasOptionType) {
    if (body.optionType !== "put" && body.optionType !== "call") {
      return NextResponse.json(
        { error: "optionType must be 'put' or 'call'" },
        { status: 400 },
      );
    }
    newOptionType = body.optionType;
  }

  let newBroker: string | null = null;
  if (hasBroker) {
    if (
      typeof body.broker !== "string" ||
      !(VALID_BROKERS as readonly string[]).includes(body.broker)
    ) {
      return NextResponse.json(
        { error: `broker must be one of ${VALID_BROKERS.join(", ")}` },
        { status: 400 },
      );
    }
    newBroker = body.broker;
  }

  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,option_type,position_type,opened_date,broker")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (posRes.error) {
    return NextResponse.json({ error: posRes.error.message }, { status: 500 });
  }
  const pos = posRes.data as {
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    option_type: string | null;
    position_type: string | null;
    opened_date: string;
    broker: string | null;
  } | null;
  if (!pos) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  // Strike/expiry/option type are option-only concepts — stock positions
  // store strike=0 as a placeholder, never a real contract attribute (see
  // position_type gating used throughout this codebase). Broker has no
  // such restriction — a stock lot can move accounts too — so this guard
  // only fires when one of the option-only fields was actually requested.
  if (pos.position_type === "stock" && (hasStrike || hasExpiry || hasOptionType)) {
    return NextResponse.json(
      { error: "Contract attributes only apply to option positions" },
      { status: 400 },
    );
  }

  const finalStrike = newStrike ?? Number(pos.strike);
  const finalExpiry = newExpiry ?? pos.expiry;
  const finalOptionType = newOptionType ?? (pos.option_type as "put" | "call" | null) ?? "put";
  const finalBroker = newBroker ?? pos.broker;

  const contractUnchanged =
    finalStrike === Number(pos.strike) &&
    finalExpiry === pos.expiry &&
    finalOptionType === (pos.option_type ?? "put");
  const brokerUnchanged = finalBroker === pos.broker;
  if (contractUnchanged && brokerUnchanged) {
    return NextResponse.json({
      success: true,
      id,
      strike: finalStrike,
      expiry: finalExpiry,
      optionType: finalOptionType,
      broker: finalBroker,
      changed: false,
    });
  }

  // Moving broker alone (no contract-field change) doesn't touch
  // strike/expiry/option_type or their entry_iv/entry_delta/entry_dte
  // snapshots — those are still correct for whichever real contract
  // this is, regardless of which account bucket it's filed under.
  const updatePayload: Record<string, unknown> = {};
  if (!contractUnchanged) {
    updatePayload.strike = finalStrike;
    updatePayload.expiry = finalExpiry;
    updatePayload.option_type = finalOptionType;
    updatePayload.entry_iv = null;
    updatePayload.entry_delta = null;
    updatePayload.entry_dte = null;
  }
  if (!brokerUnchanged) {
    updatePayload.broker = finalBroker;
  }

  const upd = await sb
    .from("positions")
    .update(updatePayload)
    .eq("id", id)
    .eq("user_id", userId);
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 });
  }

  // Best-effort — same fills-null-only stamp used on import. Never
  // overwrites entry_stock_price / entry_em_pct / entry_vix (left
  // untouched above, so their null-check always skips them here). Only
  // worth attempting when the contract itself actually changed — a
  // pure broker move has no new contract to restamp against.
  if (!contractUnchanged) {
    try {
      const ctx = await buildStampContext();
      await stampEntryContext(ctx, {
        id,
        symbol: pos.symbol,
        strike: finalStrike,
        expiry: finalExpiry,
        optionType: finalOptionType,
        openedDate: pos.opened_date,
        userId,
      });
    } catch (e) {
      console.warn(
        `[positions/contract-edit] restamp failed for ${id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return NextResponse.json({
    success: true,
    id,
    strike: finalStrike,
    expiry: finalExpiry,
    optionType: finalOptionType,
    broker: finalBroker,
    changed: true,
  });
}
