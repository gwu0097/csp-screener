// Long-term portfolio watchlist API. The DB row stores symbol +
// allocation + notes; live Yahoo quote enrichment is layered on at
// request time so the table doesn't have to be rebuilt every market
// tick. PATCH/DELETE accept id in body / ?id= per the spec — the
// /longterm/ideas route uses a per-id subpath; here we keep all four
// verbs on one file because the watchlist row shape is narrower.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOCATIONS = ["Large", "Medium", "Small"] as const;
type Allocation = (typeof ALLOCATIONS)[number];

type WatchlistRow = {
  id: string;
  symbol: string;
  allocation: Allocation;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type EnrichedRow = WatchlistRow & {
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  twoHundredDayAverage: number | null;
  pctVs200dSma: number | null;
  analystTargetMean: number | null;
};

const ALLOCATION_ORDER: Record<Allocation, number> = {
  Large: 0,
  Medium: 1,
  Small: 2,
};

// Live-enrich one row from Yahoo. Failures fall back to null fields
// so a single dead symbol doesn't blank the entire watchlist.
async function enrich(row: WatchlistRow): Promise<EnrichedRow> {
  let quote: Awaited<ReturnType<typeof getQuoteEnrichment>> = null;
  try {
    quote = await getQuoteEnrichment(row.symbol);
  } catch (e) {
    console.warn(
      `[watchlist] getQuoteEnrichment(${row.symbol}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }
  const price = quote?.regularMarketPrice ?? null;
  const sma200 = quote?.twoHundredDayAverage ?? null;
  const fiftyTwoWeekHigh = quote?.fiftyTwoWeekHigh ?? null;
  return {
    ...row,
    companyName: quote?.companyName ?? null,
    price,
    changePct: quote?.regularMarketChangePercent ?? null,
    fiftyTwoWeekLow: quote?.fiftyTwoWeekLow ?? null,
    fiftyTwoWeekHigh,
    pctFromFiftyTwoWeekHigh:
      price !== null && fiftyTwoWeekHigh !== null && fiftyTwoWeekHigh > 0
        ? ((price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh) * 100
        : null,
    marketCap: quote?.marketCap ?? null,
    trailingPE: quote?.trailingPE ?? null,
    forwardPE: quote?.forwardPE ?? null,
    twoHundredDayAverage: sma200,
    pctVs200dSma:
      price !== null && sma200 !== null && sma200 > 0
        ? ((price - sma200) / sma200) * 100
        : null,
    analystTargetMean: quote?.targetMeanPrice ?? null,
  };
}

export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .select("id,symbol,allocation,notes,created_at,updated_at");
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as WatchlistRow[];
  // Sort Large → Medium → Small, alphabetical within each group.
  rows.sort((a, b) => {
    const ao = ALLOCATION_ORDER[a.allocation] ?? 99;
    const bo = ALLOCATION_ORDER[b.allocation] ?? 99;
    if (ao !== bo) return ao - bo;
    return a.symbol.localeCompare(b.symbol);
  });
  // Parallel enrichment — Yahoo handles ~30 simultaneous quote calls
  // fine, and the list stays well under that.
  const enriched = await Promise.all(rows.map(enrich));
  return NextResponse.json({ watchlist: enriched });
}

type CreateBody = { symbol?: unknown; allocation?: unknown; notes?: unknown };

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  const symbol = body.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  if (
    typeof body.allocation !== "string" ||
    !(ALLOCATIONS as readonly string[]).includes(body.allocation)
  ) {
    return NextResponse.json(
      { error: "allocation must be Large / Medium / Small" },
      { status: 400 },
    );
  }
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const sb = createServerClient();
  const ins = await sb
    .from("long_term_watchlist")
    .insert({ symbol, allocation: body.allocation as Allocation, notes })
    .select()
    .single();
  if (ins.error) {
    // Unique-violation on symbol comes back as 23505. Surface a clear
    // message so the UI can show "Already in watchlist".
    const status = ins.error.code === "23505" ? 409 : 400;
    return NextResponse.json(
      { error: ins.error.message },
      { status },
    );
  }
  return NextResponse.json({ row: ins.data });
}

type PatchBody = {
  id?: unknown;
  allocation?: unknown;
  notes?: unknown;
};

export async function PATCH(req: NextRequest) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.allocation !== undefined) {
    if (
      typeof body.allocation !== "string" ||
      !(ALLOCATIONS as readonly string[]).includes(body.allocation)
    ) {
      return NextResponse.json(
        { error: "allocation must be Large / Medium / Small" },
        { status: 400 },
      );
    }
    patch.allocation = body.allocation;
  }
  if (body.notes !== undefined) {
    patch.notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim()
        : null;
  }
  if (Object.keys(patch).length === 1) {
    return NextResponse.json(
      { error: "Nothing to update" },
      { status: 400 },
    );
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ row: res.data });
}

export async function DELETE(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .delete()
    .eq("id", id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
