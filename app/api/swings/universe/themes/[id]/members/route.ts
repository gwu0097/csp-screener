import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { validateAndWarmSymbol } from "@/lib/universe";

export const dynamic = "force-dynamic";
// Adding members is the only place in this feature that does a live
// fetch (see lib/universe.ts validateAndWarmSymbol) — every other read
// (theme detail, the list view) is cache-only. A symbol is rejected only
// when Yahoo has no data for it at all; sparse-but-real data (a real
// small-cap ticker missing some optional fields) is accepted — the
// membership is the point, the enrichment is convenience.
export const maxDuration = 60;

type MemberRow = {
  id: string;
  theme_id: string;
  user_id: string;
  symbol: string;
  is_anchor: boolean;
  is_active: boolean;
  source: string;
};

type Body = { symbols?: unknown };

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const themeId = (params.id ?? "").trim();
  if (!themeId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
    return NextResponse.json({ error: "Missing symbols array" }, { status: 400 });
  }
  const requested = Array.from(
    new Set(
      body.symbols
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    ),
  );
  if (requested.length === 0) {
    return NextResponse.json({ error: "No valid symbols in request" }, { status: 400 });
  }

  const sb = createServerClient();
  const themeRes = await sb
    .from("themes")
    .select("id")
    .eq("id", themeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  if (!themeRes.data) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

  const existingRes = await sb
    .from<MemberRow>("theme_members")
    .select("id,symbol,is_active")
    .eq("theme_id", themeId)
    .eq("user_id", userId)
    .in("symbol", requested);
  if (existingRes.error) {
    return NextResponse.json({ error: existingRes.error.message }, { status: 500 });
  }
  const existingBySymbol = new Map<string, { id: string; is_active: boolean }>();
  for (const row of (existingRes.data ?? []) as Array<{ id: string; symbol: string; is_active: boolean }>) {
    existingBySymbol.set(row.symbol, { id: row.id, is_active: row.is_active });
  }

  const added: string[] = [];
  const reactivated: string[] = [];
  const alreadyActive: string[] = [];
  const invalid: string[] = [];

  for (const symbol of requested) {
    const existing = existingBySymbol.get(symbol);
    if (existing) {
      if (existing.is_active) {
        alreadyActive.push(symbol);
        continue;
      }
      const upd = await sb
        .from("theme_members")
        .update({ is_active: true })
        .eq("id", existing.id)
        .eq("user_id", userId);
      if (upd.error) {
        invalid.push(symbol);
        continue;
      }
      reactivated.push(symbol);
      continue;
    }

    const ok = await validateAndWarmSymbol(symbol);
    if (!ok) {
      invalid.push(symbol);
      continue;
    }
    const ins = await sb.from("theme_members").insert({
      theme_id: themeId,
      user_id: userId,
      symbol,
      is_anchor: false,
      source: "manual",
    });
    if (ins.error) {
      invalid.push(symbol);
      continue;
    }
    added.push(symbol);
  }

  return NextResponse.json({ added, reactivated, alreadyActive, invalid });
}
