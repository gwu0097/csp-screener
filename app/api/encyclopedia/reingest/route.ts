import { NextRequest, NextResponse } from "next/server";
import { reingestHistoricalDates } from "@/lib/encyclopedia";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

type Body = { symbols?: unknown; dryRun?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dryRun = body.dryRun === true;

  let symbols: string[];
  if (Array.isArray(body.symbols)) {
    symbols = (body.symbols as unknown[])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.toUpperCase());
  } else {
    // No list provided — re-ingest every symbol in stock_encyclopedia.
    const sb = createServerClient();
    const r = await sb.from("stock_encyclopedia").select("symbol");
    symbols = ((r.data ?? []) as Array<{ symbol: string }>).map((x) =>
      x.symbol.toUpperCase(),
    );
  }
  if (symbols.length === 0) {
    return NextResponse.json({ error: "no symbols to process" }, { status: 400 });
  }

  const results = [];
  const errors: Array<{ symbol: string; error: string }> = [];
  for (const sym of symbols) {
    try {
      const report = await reingestHistoricalDates(sym, { dryRun });
      results.push(report);
    } catch (e) {
      errors.push({ symbol: sym, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results, errors, dryRun });
}
