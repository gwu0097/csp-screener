import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  POLYGON_DEPTH_CUTOFF,
  processPolygonEvent,
  type EarningsRow,
} from "@/lib/polygon-em";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Bulk Polygon EM backfill — drains earnings_history rows that have
// actual_move_pct populated but no implied_move_pct, sorted by
// earnings_date DESC (most recent first). Designed to run on the
// paid Polygon tier with noSleep=true so per-event wall-clock drops
// from ~40s (free-tier 13s spacers) to ~3-5s, letting one Vercel
// invocation cover ~5-8 events in 60s.
//
// Client (Settings → "Backfill historical EM (Polygon)") loops the
// route until totalRemaining===0 or no progress is made.
export const maxDuration = 60;

const EVENTS_PER_CALL = 5;

type Outcome =
  | { symbol: string; earningsDate: string; status: "populated"; emPct: number; strike: number }
  | { symbol: string; earningsDate: string; status: "skipped"; reason: string }
  | { symbol: string; earningsDate: string; status: "error"; reason: string };

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Body is optional — clients can pass `{ batchSize }` to override
  // EVENTS_PER_CALL on a per-invocation basis if they want smaller
  // bites for safety. Default 5.
  let batchSize = EVENTS_PER_CALL;
  try {
    const body = (await req.json().catch(() => ({}))) as { batchSize?: unknown };
    if (typeof body.batchSize === "number" && body.batchSize > 0 && body.batchSize <= 10) {
      batchSize = Math.floor(body.batchSize);
    }
  } catch {
    /* ignore — empty body is fine */
  }

  const sb = createServerClient();
  const t0 = Date.now();

  // The custom Supabase wrapper doesn't expose `count: "exact"` or
  // `.not()`, so fetch all in-window rows and filter JS-side. Even
  // for several hundred symbols × 8 quarters this is small (< 2k
  // rows of 7 numeric columns).
  const allRes = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
    )
    .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
    .order("earnings_date", { ascending: false });
  if (allRes.error) {
    return NextResponse.json(
      { error: allRes.error.message },
      { status: 500 },
    );
  }
  const all = (allRes.data ?? []) as EarningsRow[];
  const pending = all.filter(
    (r) => r.actual_move_pct !== null && r.implied_move_pct === null,
  );
  const totalRemainingAtStart = pending.length;

  if (totalRemainingAtStart === 0) {
    return NextResponse.json({
      processed: 0,
      populated: 0,
      skipped: 0,
      errored: 0,
      totalRemainingAtStart: 0,
      totalRemaining: 0,
      outcomes: [] as Outcome[],
    });
  }

  const candidates = pending.slice(0, batchSize);

  const outcomes: Outcome[] = [];
  let populated = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of candidates) {
    let outcome;
    try {
      outcome = await processPolygonEvent(row, { noSleep: true });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `[backfill-em-polygon] ${row.symbol} ${row.earnings_date} threw:`,
        e,
      );
      outcomes.push({
        symbol: row.symbol,
        earningsDate: row.earnings_date,
        status: "error",
        reason,
      });
      errored += 1;
      continue;
    }

    if (outcome.kind === "populated") {
      const upd = await sb
        .from("earnings_history")
        .update({
          implied_move_pct: outcome.emPct,
          implied_move_source: "polygon",
        })
        .eq("symbol", row.symbol)
        .eq("earnings_date", row.earnings_date);
      if (upd.error) {
        outcomes.push({
          symbol: row.symbol,
          earningsDate: row.earnings_date,
          status: "error",
          reason: `DB write failed: ${upd.error.message}`,
        });
        errored += 1;
      } else {
        outcomes.push({
          symbol: row.symbol,
          earningsDate: row.earnings_date,
          status: "populated",
          emPct: outcome.emPct,
          strike: outcome.strike,
        });
        populated += 1;
      }
    } else {
      let reason: string;
      if (outcome.kind === "skip_too_old") {
        reason = "outside Polygon 24-month window";
      } else if (
        outcome.kind === "skip_no_contracts" ||
        outcome.kind === "skip_no_data" ||
        outcome.kind === "error"
      ) {
        reason = outcome.reason;
      } else {
        reason = "unknown";
      }
      outcomes.push({
        symbol: row.symbol,
        earningsDate: row.earnings_date,
        status: outcome.kind === "error" ? "error" : "skipped",
        reason,
      });
      if (outcome.kind === "error") errored += 1;
      else skipped += 1;
    }
  }

  // We populated `populated` rows out of the `pending` snapshot.
  // Skipped/errored rows still have implied_move_pct null, so they
  // remain. New rows (events that landed since the snapshot) won't
  // affect this loop's counter — the client re-snapshots on the
  // next batch call anyway.
  const totalRemaining = totalRemainingAtStart - populated;

  console.log(
    `[backfill-em-polygon] processed ${candidates.length} populated=${populated} skipped=${skipped} errored=${errored} ` +
      `remaining=${totalRemaining} (was ${totalRemainingAtStart}) in ${Date.now() - t0}ms`,
  );

  return NextResponse.json({
    processed: candidates.length,
    populated,
    skipped,
    errored,
    totalRemainingAtStart,
    totalRemaining,
    outcomes,
  });
}
