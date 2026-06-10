import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// DELETE → remove an analysis
// PATCH  → update the optional notes field { notes }

type Params = { params: { symbol: string; id: string } };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_req: NextRequest, { params }: Params) {
  const symbol = params.symbol.trim().toUpperCase();
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const sb = createServerClient();
  // Scope the delete to the symbol in the path so a stray id can't
  // remove another stock's analysis.
  const r = await sb
    .from("filing_analyses")
    .delete()
    .eq("id", params.id)
    .eq("symbol", symbol)
    .select("id");
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  if ((r.data ?? []).length === 0) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const symbol = params.symbol.trim().toUpperCase();
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  let body: { notes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.notes !== "string" || body.notes.length > 10_000) {
    return NextResponse.json(
      { error: "notes must be a string (max 10k chars)" },
      { status: 400 },
    );
  }
  const sb = createServerClient();
  const r = await sb
    .from("filing_analyses")
    .update({ notes: body.notes.trim() || null })
    .eq("id", params.id)
    .eq("symbol", symbol)
    .select("*");
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  if ((r.data ?? []).length === 0) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }
  return NextResponse.json({ analysis: r.data?.[0] });
}
