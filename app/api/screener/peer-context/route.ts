import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// PEER CONTEXT for the Analysis Dump — facts only. For the target
// symbol's own active/approved theme(s), lists other members that
// reported earnings in the trailing 21 days before the target's
// earnings date, with their actual move. This is read-only evidence
// the analysis dump surfaces to a human/LLM reader; it is never wired
// into computeCrushComposite, runStageFour, or calculateThreeLayerGrade
// (lib/screener.ts) — no caller may use this route's output to compute
// a grade or score.
//
// Uses TODAY's active theme membership to describe a forward-looking
// (not-yet-happened) earnings event — that's the correct, unbiased use
// of current membership. It is NOT safe to reuse this route's query
// shape for backtesting past entries: theme_members.added_at exists
// but there is no removed_at, so historical membership can only be
// reconstructed for additions, never removals (2026-09-02 audit). Any
// future backtest against themes must account for that gap itself.
//
// The base rate this route's peers should be read against (n=379,
// naive method — see the same 2026-09-02 audit) found NO measured
// relationship between a same-theme peer's earnings reaction and the
// subject's own subsequent reaction. That finding is surfaced as a
// permanent, hardcoded line in the dump section this route feeds
// (components/screener-view.tsx), not recomputed here — it's a fixed
// piece of context, not a live query.
export type PeerContextEvent = {
  symbol: string;
  themeName: string;
  earningsDate: string;
  actualMovePct: number | null;
};

export type PeerContextResponse = {
  themeNames: string[];
  windowStart: string;
  windowEnd: string;
  events: PeerContextEvent[];
};

type ThemeMemberRow = { theme_id: string; symbol: string };
type ThemeRow = { id: string; name: string };
type EarningsRow = { symbol: string; earnings_date: string; actual_move_pct: number | string | null };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const asOfDate = req.nextUrl.searchParams.get("asOfDate")?.trim();
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid or missing symbol" }, { status: 400 });
  }
  if (!asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return NextResponse.json({ error: "Invalid or missing asOfDate" }, { status: 400 });
  }

  const sb = createServerClient();
  const windowStart = addDays(asOfDate, -21);
  const empty: PeerContextResponse = { themeNames: [], windowStart, windowEnd: asOfDate, events: [] };

  // Step 1: which active/approved theme(s) is the target symbol in?
  const targetMemberRes = await sb
    .from("theme_members")
    .select("theme_id,symbol")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .eq("is_active", true)
    .eq("review_status", "approved");
  if (targetMemberRes.error) {
    return NextResponse.json({ error: targetMemberRes.error.message }, { status: 500 });
  }
  const themeIds = ((targetMemberRes.data ?? []) as ThemeMemberRow[]).map((r) => r.theme_id);
  if (themeIds.length === 0) {
    return NextResponse.json(empty);
  }

  const themesRes = await sb.from("themes").select("id,name").in("id", themeIds);
  if (themesRes.error) {
    return NextResponse.json({ error: themesRes.error.message }, { status: 500 });
  }
  const themeNameById = new Map<string, string>(
    ((themesRes.data ?? []) as ThemeRow[]).map((t) => [t.id, t.name]),
  );

  // Step 2: other active/approved members of those same theme(s).
  const peerMemberRes = await sb
    .from("theme_members")
    .select("theme_id,symbol")
    .eq("user_id", userId)
    .in("theme_id", themeIds)
    .eq("is_active", true)
    .eq("review_status", "approved");
  if (peerMemberRes.error) {
    return NextResponse.json({ error: peerMemberRes.error.message }, { status: 500 });
  }
  // symbol -> theme name(s) it shares with the target, for display.
  // A peer sharing more than one theme with the target is deduped to
  // its first-matched theme name below (facts-only display, not a
  // count of overlapping themes).
  const themeNameByPeerSymbol = new Map<string, string>();
  const peerSymbols = new Set<string>();
  for (const row of (peerMemberRes.data ?? []) as ThemeMemberRow[]) {
    if (row.symbol === symbol) continue;
    peerSymbols.add(row.symbol);
    if (!themeNameByPeerSymbol.has(row.symbol)) {
      themeNameByPeerSymbol.set(row.symbol, themeNameById.get(row.theme_id) ?? "unknown theme");
    }
  }
  if (peerSymbols.size === 0) {
    return NextResponse.json({ ...empty, themeNames: Array.from(themeNameById.values()) });
  }

  // Step 3: those peers' earnings in the trailing 21 days before asOfDate.
  const earningsRes = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,actual_move_pct")
    .in("symbol", Array.from(peerSymbols))
    .gte("earnings_date", windowStart)
    .lt("earnings_date", asOfDate)
    .order("earnings_date", { ascending: false });
  if (earningsRes.error) {
    return NextResponse.json({ error: earningsRes.error.message }, { status: 500 });
  }
  const events: PeerContextEvent[] = ((earningsRes.data ?? []) as EarningsRow[]).map((r) => ({
    symbol: r.symbol,
    themeName: themeNameByPeerSymbol.get(r.symbol) ?? "unknown theme",
    earningsDate: r.earnings_date,
    actualMovePct: r.actual_move_pct !== null ? Number(r.actual_move_pct) : null,
  }));

  const response: PeerContextResponse = {
    themeNames: Array.from(themeNameById.values()),
    windowStart,
    windowEnd: asOfDate,
    events,
  };
  return NextResponse.json(response);
}
