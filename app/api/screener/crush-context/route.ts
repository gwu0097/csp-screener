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

type Body = {
  symbol?: unknown;
  companyName?: unknown;
  currentEM?: unknown;
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
  // One row per (symbol, analyzed_date). PostgREST upserts via
  // onConflict; we're keyed on the unique constraint already present
  // in the table (see DDL in the route comment below).
  const cacheRes = await sb
    .from("screener_crush_context")
    .select("context")
    .eq("symbol", symbol)
    .eq("analyzed_date", today)
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
  // Upsert keyed on (symbol, analyzed_date). The table's UNIQUE
  // constraint protects against duplicates if two requests race.
  const writeRes = await sb
    .from("screener_crush_context")
    .upsert(
      { symbol, analyzed_date: today, context },
      { onConflict: "symbol,analyzed_date" },
    );
  if (writeRes.error) {
    // Cache write failure is non-fatal — return the context we computed.
    console.warn(
      `[crush-context] ${symbol} cache write failed: ${writeRes.error.message}`,
    );
  }

  return NextResponse.json({ context, cached: false });
}
