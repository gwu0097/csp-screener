import { NextRequest, NextResponse } from "next/server";
import { updateEncyclopedia } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

type Body = { symbols?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbols = Array.isArray(body.symbols)
    ? (body.symbols as unknown[])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.toUpperCase())
    : [];
  if (symbols.length === 0) {
    return NextResponse.json({ error: "symbols array required" }, { status: 400 });
  }

  const updated: Array<{ symbol: string; newRecords: number; updatedRecords: number }> = [];
  const errors: Array<{ symbol: string; error: string }> = [];
  for (const sym of symbols) {
    try {
      const s = await updateEncyclopedia(sym);
      updated.push({ symbol: s.symbol, newRecords: s.newRecords, updatedRecords: s.updatedRecords });
    } catch (e) {
      errors.push({ symbol: sym, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ updated, errors });
}
