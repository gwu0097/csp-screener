import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Screener History, reorganized by earnings event (2026-09-04) —
// previously organized by scan run (still browsable via
// /api/screener/results/history, unchanged). One row per
// (symbol, earnings_date); a ticker screened 3x in one day appears once.
//
// EM and actual move come from earnings_history (implied_move_pct /
// actual_move_pct) — the T0-pinned pre-event baseline and the T1
// post-event reaction — NEVER from a candidate's
// stageThree.details.expectedMovePct, which is a live straddle read off
// whatever the chain looks like at scan time and reads post-crush for
// an already-reported name (confirmed live 2026-09-03: CIEN showed
// 3.4% live vs its real 11.4% T0 baseline). See crush-history-table.tsx
// for the same fix applied to the per-symbol History tab.
//
// "Grade at scan" is read from the LAST screener_results candidate for
// this (symbol, earnings_date) pair classified pre-event — not the most
// recent scan overall, which could be a post-print re-scan grading a
// different (already-crushed) situation. All scans for the event are
// still returned (never discarded — scan-to-scan grade drift has
// surfaced real data bugs before), just deprioritized behind a "N
// scans" affordance client-side.
//
// Pre/post classification (fixed 2026-09-04 — the original version
// compared calendar dates only, which mislabeled 16 of 18 same-day AMC
// scans this week as "post-print" when they ran hours before the actual
// 4pm+ ET announcement): a scan on a calendar day strictly before
// earnings_date is always pre-event regardless of session. A scan on
// the print day itself needs the real session to classify — AMC's cutoff
// is 4:00pm ET (the announcement), BMO's is 9:30am ET (market open,
// since the print itself already happened before that). When timing is
// neither "bmo" nor "amc" (including the stored value "unknown" — CIEN's
// case), a same-day scan is NOT guessed at either direction; it's
// reported as its own "timing unknown" state rather than silently
// defaulting to pre- or post-event.

type EarningsHistoryRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  timing: string | null;
  implied_move_pct: number | string | null;
  actual_move_pct: number | string | null;
};

type ScreenerResultRow = {
  id: string;
  screened_at: string | null;
  candidates: unknown;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function candidateGrade(c: Record<string, unknown>): string | null {
  const stageThree = c.stageThree as Record<string, unknown> | null | undefined;
  return stageThree && typeof stageThree.crushGrade === "string" ? stageThree.crushGrade : null;
}

type Scan = { runId: string; screenedAt: string; grade: string | null; candidate: Record<string, unknown> };

// Eastern calendar date + fractional hour for a Postgres timestamptz
// string, via Intl so EDT/EST is handled correctly (a naive fixed UTC
// offset breaks across the DST boundary) — the wire format is
// "YYYY-MM-DD HH:MM:SS.sss+00", which Date() accepts once the space is
// swapped for "T".
function etDateAndHour(screenedAtIso: string): { date: string; hour: number } {
  const d = new Date(screenedAtIso.replace(" ", "T"));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) + Number(get("minute")) / 60,
  };
}

const AMC_CUTOFF_ET_HOUR = 16; // 4:00pm ET announcement
const BMO_CUTOFF_ET_HOUR = 9.5; // 9:30am ET market open (BMO already printed before this)

type ScanVerdict = "pre" | "post" | "unknown";

function classifyScan(screenedAtIso: string, earningsDate: string, timing: string | null): ScanVerdict {
  const { date: scanDate, hour: scanHour } = etDateAndHour(screenedAtIso);
  if (scanDate < earningsDate) return "pre"; // any earlier calendar day is safe regardless of session
  if (scanDate > earningsDate) return "post";
  if (timing === "amc") return scanHour < AMC_CUTOFF_ET_HOUR ? "pre" : "post";
  if (timing === "bmo") return scanHour < BMO_CUTOFF_ET_HOUR ? "pre" : "post";
  return "unknown"; // same day, session not known — don't guess which cutoff applies
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const from = req.nextUrl.searchParams.get("from") || defaultFrom;
  const to = req.nextUrl.searchParams.get("to") || today;
  const symbolParam = req.nextUrl.searchParams.get("symbol");

  const sb = createServerClient();

  // A ticker search must reach the whole history, not just whatever
  // date range happens to be selected — the date pickers and search are
  // two independent ways to scope the same table, not one filtering the
  // other. Exact symbol match only: the shared Supabase wrapper has no
  // ilike/substring filter (see lib/supabase.ts), and a personal app
  // with a handful of thousand earnings_history rows doesn't need one —
  // the user types a real ticker, not a fragment.
  const ehRes = symbolParam
    ? await sb
        .from("earnings_history")
        .select("id,symbol,earnings_date,timing,implied_move_pct,actual_move_pct")
        .eq("symbol", symbolParam.toUpperCase())
    : await sb
        .from("earnings_history")
        .select("id,symbol,earnings_date,timing,implied_move_pct,actual_move_pct")
        .gte("earnings_date", from)
        .lte("earnings_date", to);
  if (ehRes.error) {
    return NextResponse.json({ error: ehRes.error.message }, { status: 500 });
  }
  const events = (ehRes.data ?? []) as EarningsHistoryRow[];
  if (events.length === 0) {
    return NextResponse.json({ events: [] });
  }

  // Key by (symbol, earnings_date) for matching against scan candidates.
  const eventByKey = new Map<string, EarningsHistoryRow>();
  for (const e of events) {
    eventByKey.set(`${e.symbol.toUpperCase()}|${e.earnings_date}`, e);
  }

  // All of this user's scans — 57 rows total as of 2026-09, cheap to
  // scan in full rather than trying to bound by screened_at (a scan
  // from well before `from` can still be the "last scan before" an
  // event whose earnings_date falls inside [from, to]).
  const srRes = await sb
    .from("screener_results")
    .select("id,screened_at,candidates")
    .eq("user_id", userId)
    .order("screened_at", { ascending: true });
  if (srRes.error) {
    return NextResponse.json({ error: srRes.error.message }, { status: 500 });
  }
  const runs = (srRes.data ?? []) as ScreenerResultRow[];

  const scansByEventKey = new Map<string, Scan[]>();
  for (const run of runs) {
    if (!run.screened_at) continue;
    const cands = Array.isArray(run.candidates) ? run.candidates : [];
    for (const raw of cands) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const symbol = typeof c.symbol === "string" ? c.symbol.toUpperCase() : null;
      const earningsDate = typeof c.earningsDate === "string" ? c.earningsDate : null;
      if (!symbol || !earningsDate) continue;
      const key = `${symbol}|${earningsDate}`;
      if (!eventByKey.has(key)) continue; // not one of the events in scope
      const list = scansByEventKey.get(key) ?? [];
      list.push({ runId: run.id, screenedAt: run.screened_at, grade: candidateGrade(c), candidate: c });
      scansByEventKey.set(key, list);
    }
  }

  // Position linkage — one query for the whole window rather than one
  // per event.
  const posRes = await sb
    .from("positions")
    .select("earnings_history_id")
    .eq("user_id", userId)
    .in("earnings_history_id", events.map((e) => e.id));
  const linkedEventIds = new Set(
    ((posRes.data ?? []) as Array<{ earnings_history_id: string | null }>)
      .map((p) => p.earnings_history_id)
      .filter((id): id is string => id !== null),
  );

  const result = events
    .map((e) => {
      const key = `${e.symbol.toUpperCase()}|${e.earnings_date}`;
      const scans = (scansByEventKey.get(key) ?? []).sort((a, b) => a.screenedAt.localeCompare(b.screenedAt));
      const withVerdict = scans.map((s) => ({
        ...s,
        verdict: classifyScan(s.screenedAt, e.earnings_date, e.timing),
      }));
      const preEventScans = withVerdict.filter((s) => s.verdict === "pre");
      const unknownScans = withVerdict.filter((s) => s.verdict === "unknown");
      const scanForGrade = preEventScans.length > 0 ? preEventScans[preEventScans.length - 1] : null;

      // "resolved": a real pre-event scan exists. "post_print_only":
      // every scan we have is confirmed post-event (session-aware, not
      // just same-day). "timing_unknown": no confirmed pre-event scan,
      // but at least one same-day scan couldn't be classified because
      // this row's own timing isn't known — reported as its own state
      // rather than folded into "post_print_only", which would claim a
      // certainty this data doesn't have. "not_scanned": zero scans at all.
      const gradeAtScanStatus: "resolved" | "post_print_only" | "timing_unknown" | "not_scanned" =
        scanForGrade !== null
          ? "resolved"
          : scans.length === 0
            ? "not_scanned"
            : unknownScans.length > 0
              ? "timing_unknown"
              : "post_print_only";

      // Drill-down detail: the same scan the grade came from, so
      // "Grade at scan" and the expanded detail never disagree. Falls
      // back to the most recent scan otherwise (post-print or
      // unclassifiable, if that's all that exists) purely so a row still
      // has something to expand into — the UI must make clear which
      // case it is.
      const drilldownScan = scanForGrade ?? (scans.length > 0 ? withVerdict[withVerdict.length - 1] : null);

      const impliedMovePct = num(e.implied_move_pct);
      const actualMovePct = num(e.actual_move_pct);
      const ratio =
        impliedMovePct !== null && impliedMovePct !== 0 && actualMovePct !== null
          ? Math.abs(actualMovePct) / impliedMovePct
          : null;

      return {
        eventId: e.id,
        symbol: e.symbol.toUpperCase(),
        earningsDate: e.earnings_date,
        timing: e.timing,
        impliedMovePct,
        actualMovePct,
        ratio,
        gradeAtScan: scanForGrade?.grade ?? null,
        gradeAtScanStatus,
        hasPosition: linkedEventIds.has(e.id),
        scans: withVerdict.map((s) => ({ runId: s.runId, screenedAt: s.screenedAt, grade: s.grade, verdict: s.verdict })),
        drilldownCandidate: drilldownScan?.candidate ?? null,
        drilldownScreenedAt: drilldownScan?.screenedAt ?? null,
      };
    })
    .sort((a, b) => b.earningsDate.localeCompare(a.earningsDate));

  return NextResponse.json({ events: result, from, to });
}
