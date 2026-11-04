import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { tradedKey, type TradedEvent } from "@/lib/traded-status";
import { loadTradedStatuses } from "@/lib/traded-status-loader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// "Already traded" chip for the screener table. Personal data: every
// query is scoped by requireUserId(). Matching rules live in
// lib/traded-status.ts; loading in lib/traded-status-loader.ts.
//
// GET  /api/screener/traded?events=COHR:2026-11-04,CELH:2026-11-05
//   → { statuses: { "COHR|2026-11-04": TradedStatus, ... } }
//   One batched call for the whole screen, never one per row.
// POST /api/screener/traded { symbol, earningsDate, traded: boolean }
//   Sets or clears the user's manual mark for one event.

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shape AND calendar validity: 2026-13-45 matches DATE_RE but isn't a date.
function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
const MAX_EVENTS = 200;

function parseEvents(param: string | null): TradedEvent[] | null {
  if (!param) return [];
  const seen = new Set<string>();
  const out: TradedEvent[] = [];
  for (const part of param.split(",")) {
    if (part.trim() === "") continue;
    const [rawSym, rawDate] = part.trim().split(":");
    const symbol = (rawSym ?? "").toUpperCase();
    const earningsDate = rawDate ?? "";
    if (!SYMBOL_RE.test(symbol) || !isIsoDate(earningsDate)) return null;
    const key = tradedKey(symbol, earningsDate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, earningsDate });
  }
  return out;
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const events = parseEvents(req.nextUrl.searchParams.get("events"));
  if (events === null) {
    return NextResponse.json({ error: "Malformed events (expected SYMBOL:YYYY-MM-DD,...)" }, { status: 400 });
  }
  if (events.length > MAX_EVENTS) {
    return NextResponse.json({ error: `Too many events (max ${MAX_EVENTS})` }, { status: 400 });
  }
  if (events.length === 0) return NextResponse.json({ statuses: {} });

  try {
    const statuses = await loadTradedStatuses(userId, events);
    return NextResponse.json({ statuses: Object.fromEntries(statuses) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { symbol?: unknown; earningsDate?: unknown; traded?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const earningsDate = typeof body.earningsDate === "string" ? body.earningsDate : "";
  if (!SYMBOL_RE.test(symbol) || !isIsoDate(earningsDate) || typeof body.traded !== "boolean") {
    return NextResponse.json({ error: "Expected { symbol, earningsDate: YYYY-MM-DD, traded: boolean }" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = body.traded
    ? await sb
        .from("screener_traded_marks")
        .upsert({ user_id: userId, symbol, earnings_date: earningsDate }, { onConflict: "user_id,symbol,earnings_date" })
    : await sb
        .from("screener_traded_marks")
        .delete()
        .eq("user_id", userId)
        .eq("symbol", symbol)
        .eq("earnings_date", earningsDate);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
