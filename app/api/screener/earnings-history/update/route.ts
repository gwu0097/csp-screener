import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { gradeFromRatio, quarterLabel, type CrushHistoryEvent } from "@/lib/earnings-history-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Manual EM/Actual backfill for a single earnings_history row, entered
// by hand from an external source (ThinkorSwim) when the automated
// feed came up "EM not available". Ratio and grade are NEVER accepted
// from the client — always recomputed here from the submitted EM/Actual
// so they can't independently disagree with their own inputs. Marks
// implied_move_source="manual" on the row (row-level, not per-field —
// matches how "FETCH EM HISTORY must skip manual rows" is scoped) so
// the automated fetch path never overwrites a hand-entered value. No
// auth gate, matching this route's closest sibling (fetch-em-history) —
// earnings_history is shared market data, not a per-user table.
export const maxDuration = 10;

type Body = {
  symbol?: unknown;
  earningsDate?: unknown;
  impliedMovePct?: unknown; // null clears the value
  actualMovePct?: unknown; // null clears the value
};

// Accepts a finite number, or null/undefined -> null (explicit clear).
// Anything else (NaN, non-numeric string, etc.) is a validation error,
// not silently coerced.
function parseNullableNumber(v: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { ok: false, error: `${field} must be a finite number or null` };
  }
  return { ok: true, value: v };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const earningsDate = typeof body.earningsDate === "string" ? body.earningsDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) {
    return NextResponse.json({ error: "Invalid earningsDate (expected YYYY-MM-DD)" }, { status: 400 });
  }

  const em = parseNullableNumber(body.impliedMovePct, "impliedMovePct");
  if (!em.ok) return NextResponse.json({ error: em.error }, { status: 400 });
  const actual = parseNullableNumber(body.actualMovePct, "actualMovePct");
  if (!actual.ok) return NextResponse.json({ error: actual.error }, { status: 400 });

  // Same ratio formula as everywhere else that computes it
  // (fetch-em-history, getCrushHistory, calculateBreachAnalysis):
  // |actual| / implied, magnitude-only — direction is already carried
  // separately by actualMovePct's own sign.
  const ratio =
    em.value !== null && em.value > 0 && actual.value !== null
      ? Math.abs(actual.value) / em.value
      : null;
  const grade = gradeFromRatio(ratio);

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .upsert(
      {
        symbol,
        earnings_date: earningsDate,
        implied_move_pct: em.value,
        actual_move_pct: actual.value,
        move_ratio: ratio,
        implied_move_source: "manual",
        is_complete: em.value !== null && actual.value !== null,
      },
      { onConflict: "symbol,earnings_date" },
    );
  if (up.error) {
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  const event: CrushHistoryEvent = {
    earningsDate,
    qtrLabel: quarterLabel(earningsDate),
    impliedMovePct: em.value,
    actualMovePct: actual.value,
    ratio,
    grade,
    impliedMoveSource: "manual",
  };
  return NextResponse.json({ event });
}
