import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import {
  buildCrushContextPrompt,
  parseCrushContext,
  type CrushContext,
  type OutlierQuarter,
} from "@/lib/crush-context";

export const dynamic = "force-dynamic";
// Single Perplexity call (~3-8s) plus two Supabase round-trips. Easily
// fits inside the 60s Hobby ceiling.
export const maxDuration = 60;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

function validIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

type Body = {
  symbol?: unknown;
  companyName?: unknown;
  currentEM?: unknown;
  earningsDate?: unknown;
  outlierQuarters?: unknown;
};

function isOutlierQuarter(v: unknown): v is OutlierQuarter {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.date === "string" &&
    typeof o.actualMove === "number" &&
    typeof o.ratio === "number" &&
    typeof o.impliedMove === "number" &&
    (o.direction === "up" || o.direction === "down")
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const companyName =
    typeof body.companyName === "string" ? body.companyName.trim() : "";
  const earningsDate =
    typeof body.earningsDate === "string" && validIsoDate(body.earningsDate)
      ? body.earningsDate
      : "";
  if (!earningsDate) {
    return NextResponse.json(
      { error: "earningsDate (YYYY-MM-DD) is required" },
      { status: 400 },
    );
  }
  const outlierQuartersRaw = Array.isArray(body.outlierQuarters)
    ? (body.outlierQuarters as unknown[])
    : [];
  const outlierQuarters = outlierQuartersRaw.filter(isOutlierQuarter);
  if (outlierQuarters.length === 0) {
    return NextResponse.json(
      { error: "outlierQuarters must contain at least one valid entry" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const today = todayIso();

  // ---- Cache lookup ----
  // One row per (symbol, earnings_date) — see migration 009. The cache
  // is now event-scoped, not day-scoped, so historical context for a
  // past quarter survives the next quarter's run.
  const cacheRes = await sb
    .from("screener_crush_context")
    .select("context")
    .eq("symbol", symbol)
    .eq("earnings_date", earningsDate)
    .limit(1);
  if (cacheRes.error) {
    console.warn(
      `[crush-context] ${symbol} cache lookup failed: ${cacheRes.error.message}`,
    );
  } else if (cacheRes.data && cacheRes.data.length > 0) {
    const cached = (cacheRes.data[0] as { context: CrushContext })?.context;
    if (cached) {
      return NextResponse.json({ context: cached, cached: true });
    }
  }

  // ---- Perplexity call ----
  const prompt = buildCrushContextPrompt({
    symbol,
    companyName,
    outlierQuarters,
  });
  let context: CrushContext | null = null;
  try {
    const raw = await askPerplexityRaw(prompt, {
      label: `crush-context:${symbol}`,
      maxTokens: 1400,
    });
    if (raw?.text) context = parseCrushContext(raw.text);
  } catch (e) {
    console.warn(
      `[crush-context] ${symbol} Perplexity call failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  if (!context) {
    return NextResponse.json(
      { error: "Failed to obtain a usable Perplexity response" },
      { status: 502 },
    );
  }

  // ---- Cache write ----
  // Upsert keyed on (symbol, earnings_date). analyzed_date is still
  // recorded so we can tell when the context was researched, but the
  // unique key is the earnings event so re-running on a different day
  // updates rather than orphans the row.
  const writeRes = await sb
    .from("screener_crush_context")
    .upsert(
      { symbol, earnings_date: earningsDate, analyzed_date: today, context },
      { onConflict: "symbol,earnings_date" },
    );
  if (writeRes.error) {
    // Cache write failure is non-fatal — return the context we computed.
    console.warn(
      `[crush-context] ${symbol} cache write failed: ${writeRes.error.message}`,
    );
  }

  return NextResponse.json({ context, cached: false });
}
