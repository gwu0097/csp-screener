import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getCrushHistory, type CrushHistoryEvent } from "@/lib/earnings-history-table";
import { isWeekend } from "@/lib/quarter-label";
import { writeEarningsHistory } from "@/lib/earnings-history-writer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/screener/earnings-history/edit-date
//
// Corrects earnings_date on an ALREADY-REAL row (a mistyped manual
// entry, e.g. FUTU's CQ1 26 landing on the wrong day) — a materially
// different operation from the main update route, which always
// upserts by {symbol, earnings_date} and has no way to rename a row's
// key. This route rekeys via id (writeEarningsHistory's id mode +
// newEarningsDate), so every other stored field (EM, actual, ratio,
// grade, provenance) carries over untouched — only earnings_date moves.
//
// Always asserts date_confidence=human_verified: a human just
// explicitly retyped this exact date, which is the same "I checked a
// source" attestation the placeholder-resolve dialog's
// dateHumanConfirmed makes.
//
// No merge-on-conflict: if a row already exists at newEarningsDate,
// this returns an error rather than guessing which one should win —
// same "leave it to a human, don't silently merge" stance as the rest
// of this write layer.
export const maxDuration = 10;

type Body = {
  symbol?: unknown;
  oldEarningsDate?: unknown;
  newEarningsDate?: unknown;
};

function parseDate(v: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { ok: false, error: `${field} must be YYYY-MM-DD` };
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
  const oldDate = parseDate(body.oldEarningsDate, "oldEarningsDate");
  if (!oldDate.ok) return NextResponse.json({ error: oldDate.error }, { status: 400 });
  const newDate = parseDate(body.newEarningsDate, "newEarningsDate");
  if (!newDate.ok) return NextResponse.json({ error: newDate.error }, { status: 400 });

  if (isWeekend(newDate.value)) {
    return NextResponse.json(
      { error: `${newDate.value} is a Saturday/Sunday — markets are closed, this can't be a real earnings date` },
      { status: 400 },
    );
  }
  if (newDate.value === oldDate.value) {
    return NextResponse.json({ error: "New date is the same as the current date" }, { status: 400 });
  }

  const sb = createServerClient();
  const existing = await sb
    .from("earnings_history")
    .select("id")
    .eq("symbol", symbol)
    .eq("earnings_date", oldDate.value)
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ error: existing.error.message }, { status: 500 });
  }
  const row = existing.data as { id: string } | null;
  if (!row) {
    return NextResponse.json({ error: `No row found for ${symbol} at ${oldDate.value}` }, { status: 404 });
  }

  const conflict = await sb
    .from("earnings_history")
    .select("id")
    .eq("symbol", symbol)
    .eq("earnings_date", newDate.value)
    .maybeSingle();
  if (conflict.error) {
    return NextResponse.json({ error: conflict.error.message }, { status: 500 });
  }
  if (conflict.data) {
    return NextResponse.json(
      { error: `${symbol} already has a row at ${newDate.value} — resolve the duplicate manually before renaming.` },
      { status: 409 },
    );
  }

  const up = await writeEarningsHistory({
    id: row.id,
    attemptedBy: "manual_em_editor",
    dataSource: "manual_em_editor",
    tier: "human_verified",
    newEarningsDate: newDate.value,
    fields: {},
  });
  if (up.outcome === "error") {
    return NextResponse.json({ error: up.message }, { status: 500 });
  }
  if (up.outcome === "rejected") {
    return NextResponse.json(
      {
        rejected: true,
        rejection: up.rejection,
        error: `Rejected by the precedence guard — stored tier ${up.rejection.storedTier} outranks the attempted write. Nothing was changed.`,
      },
      { status: 409 },
    );
  }

  const history = await getCrushHistory(symbol, 8);
  const event: CrushHistoryEvent | undefined = history.find((e) => e.earningsDate === newDate.value);
  if (!event) {
    return NextResponse.json({ error: "Rename succeeded but the row could not be re-read" }, { status: 500 });
  }
  return NextResponse.json({ event, oldEarningsDate: oldDate.value });
}
