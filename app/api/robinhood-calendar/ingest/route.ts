import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  minRowsFloor,
  validateRobinhoodCalendarPayload,
  courierWindow,
  addDaysIso,
  isIsoDate,
  type RowsFloor,
} from "@/lib/robinhood-calendar-validate";
import { getLatestRhBatchMeta, insertRhBatch, pruneOldRhBatches, readRhBatchRows } from "@/lib/robinhood-calendar-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/robinhood-calendar/ingest?today=YYYY-MM-DD
//
// Landing endpoint for the local Robinhood earnings courier
// (scripts/robinhood-earnings-courier.ts). Body is the compact
// {"count", "rows"} projection of get_earnings_calendar. The whole
// batch is validated (lib/robinhood-calendar-validate.ts) and either
// written in full or rejected with nothing written — the courier turns
// a non-2xx into a Discord failure alert.
//
// Auth: Authorization: Bearer $CRON_SECRET (lib/cron-auth.ts). On the
// middleware public allowlist, so this check is its only protection.

function todayEt(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const anchor = req.nextUrl.searchParams.get("today") ?? "";
  if (!isIsoDate(anchor)) {
    return NextResponse.json({ ok: false, error: "today (YYYY-MM-DD) required" }, { status: 400 });
  }
  // The courier always sends "today ET"; allow a day of slack for a
  // run straddling midnight ET, reject anything else as a wrong window.
  const today = todayEt();
  if (anchor < addDaysIso(today, -1) || anchor > addDaysIso(today, 1)) {
    return NextResponse.json({ ok: false, error: `today ${anchor} is not today (${today} ET)` }, { status: 400 });
  }
  const { start: windowStart, end: windowEnd } = courierWindow(anchor);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body is not valid JSON" }, { status: 400 });
  }

  try {
    // Sanity floor from the previous batch's rows on the dates both
    // windows cover (see minRowsFloor for why it isn't a fixed number).
    let floor: RowsFloor | null = null;
    const prev = await getLatestRhBatchMeta();
    if (prev) {
      const start = prev.windowStart > windowStart ? prev.windowStart : windowStart;
      const end = prev.windowEnd < windowEnd ? prev.windowEnd : windowEnd;
      if (start <= end) {
        const prevRows = await readRhBatchRows(prev.id, start, end);
        floor = { start, end, min: minRowsFloor(prevRows.length) };
      }
    }

    const v = validateRobinhoodCalendarPayload(payload, { start: windowStart, end: windowEnd }, floor);
    if (!v.ok) {
      console.warn(`[robinhood-calendar] batch rejected for ${windowStart}..${windowEnd}: ${v.error}`);
      return NextResponse.json({ ok: false, error: v.error }, { status: 422 });
    }

    const meta = await insertRhBatch({
      windowStart,
      windowEnd,
      rows: v.rows,
      source: req.nextUrl.searchParams.get("source") ?? "courier",
    });
    const pruneError = await pruneOldRhBatches();
    if (pruneError) console.warn(`[robinhood-calendar] prune failed: ${pruneError}`);
    console.log(
      `[robinhood-calendar] batch=${meta.id} window=${windowStart}..${windowEnd} rows=${v.rows.length} ` +
        `reported=${v.reportedCount} duplicates=${v.duplicatesCollapsed} floor=${floor?.min ?? 0}`,
    );
    return NextResponse.json({
      ok: true,
      batchId: meta.id,
      rowCount: v.rows.length,
      duplicatesCollapsed: v.duplicatesCollapsed,
      floor: floor?.min ?? 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[robinhood-calendar] ingest failed: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
