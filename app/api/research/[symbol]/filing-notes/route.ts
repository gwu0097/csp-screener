import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/research/[symbol]/filing-notes
//
// Inserts a journal entry into filing_notes. Free-form text plus
// optional structured fields (key_risks, key_tailwinds, trade_relevance).
// Surfaced inside the system-context block of every Export for Review
// markdown so future reviews carry forward prior findings.

type Body = {
  notes?: unknown;
  quarter?: unknown;
  filing_type?: unknown;
  period_end?: unknown;
  key_risks?: unknown;
  key_tailwinds?: unknown;
  trade_relevance?: unknown;
};

function validSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

function strOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

function strArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  return out.length > 0 ? out : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const notes = strOrNull(body.notes);
  if (!notes) {
    return NextResponse.json(
      { error: "notes is required" },
      { status: 400 },
    );
  }
  const quarter = strOrNull(body.quarter);
  const filing_type = strOrNull(body.filing_type);
  const period_end =
    typeof body.period_end === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.period_end)
      ? body.period_end
      : null;
  const key_risks = strArrayOrNull(body.key_risks);
  const key_tailwinds = strArrayOrNull(body.key_tailwinds);
  const trade_relevance = (() => {
    const s = strOrNull(body.trade_relevance);
    if (s === null) return null;
    const lower = s.toLowerCase();
    if (lower === "bullish" || lower === "bearish" || lower === "neutral") {
      return lower;
    }
    return null;
  })();

  const sb = createServerClient();
  const ins = await sb.from("filing_notes").insert({
    symbol,
    quarter,
    filing_type,
    period_end,
    notes,
    key_risks,
    key_tailwinds,
    trade_relevance,
  });
  if (ins.error) {
    return NextResponse.json(
      { error: `filing_notes insert failed — ${ins.error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
