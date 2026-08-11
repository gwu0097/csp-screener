import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { gradeFromRatio, type CrushHistoryEvent } from "@/lib/earnings-history-table";
import { quarterLabel, isRepresentativeDateSlot, isWeekend } from "@/lib/quarter-label";

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
  // Hard reject — unlike the placeholder-slot check below, there is no
  // legitimate case for this: markets are closed, so no announcement or
  // price reaction can occur on a Saturday or Sunday. This is exactly
  // what let SMCI's CQ4 24 row land on 2025-02-01 (audit: 2026-08-11).
  if (isWeekend(earningsDate)) {
    return NextResponse.json(
      { error: `${earningsDate} is a Saturday/Sunday — markets are closed, this can't be a real earnings date` },
      { status: 400 },
    );
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

  // Soft signal, not a rejection — a real report can coincidentally land
  // on a representativeDate() slot (CAVA's 2025-05-15 Q1 print did), so
  // blocking would reject valid data. Downgrading to 'low' instead just
  // asks for a second look; the 2026-08-11 audit found 23 rows where a
  // placeholder date was never corrected and silently stamped
  // 'confirmed' by this route's own DB-default, undetected until an
  // unrelated bug report years later. When it doesn't match, this
  // route still doesn't set date_confidence at all (preserves whatever
  // the row already has on an update, or the DB default on insert) —
  // only the match case is new behavior.
  const placeholderMatch = isRepresentativeDateSlot(earningsDate);
  const warning = placeholderMatch
    ? `${earningsDate} matches a placeholder report-date slot (the 15th of Feb/May/Aug/Nov) — ` +
      `saved, but marked low-confidence until the real date is confirmed against a source like ThinkorSwim.`
    : null;

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
        ...(placeholderMatch ? { date_confidence: "low" } : {}),
      },
      { onConflict: "symbol,earnings_date" },
    );
  if (up.error) {
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  // This upsert doesn't touch fiscal_quarter/fiscal_year/period_end —
  // whatever the row already has (or doesn't) is unknown here without a
  // re-read, so the label falls back to calendar-only (fiscal ?) rather
  // than guessing. The next real fetch (getCrushHistory) re-reads the
  // row and shows the true stored label and date_confidence.
  const label = quarterLabel({
    earningsDate,
    fiscalQuarter: null,
    fiscalYear: null,
    periodEnd: null,
  });
  const event: CrushHistoryEvent = {
    earningsDate,
    qtrLabel: label.combined,
    fiscalQuarter: null,
    fiscalYear: null,
    periodEnd: null,
    fiscalKnown: false,
    impliedMovePct: em.value,
    actualMovePct: actual.value,
    ratio,
    grade,
    impliedMoveSource: "manual",
    dateConfidence: placeholderMatch ? "low" : null,
    // Unknown here without a re-read (see comment above) — same
    // fallback rationale as fiscalQuarter.
    t1Unrecoverable: false,
  };
  return NextResponse.json(warning ? { event, warning } : { event });
}
