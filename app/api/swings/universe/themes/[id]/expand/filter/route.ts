import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { filterAndQueueSuggestions, type ExpansionSuggestion } from "@/lib/theme-expansion";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase C — stage 2 of expansion: hard-filters ONE
// CHUNK of suggestions from ../suggest and inserts survivors as
// review_status='pending' theme_members rows. The client chunks the
// (up to 40) suggestion list and calls this sequentially, same
// discipline as the RS Pullback enrichment/Phase B backfill chunking —
// never all 40 in one call (each one does a live Yahoo profile fetch
// plus a bar backfill per survivor).
export const maxDuration = 60;

type Body = { suggestions?: unknown };

function isSuggestion(v: unknown): v is ExpansionSuggestion {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.symbol === "string" && o.symbol.trim().length > 0;
}

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
  if (!Array.isArray(body.suggestions) || body.suggestions.length === 0) {
    return NextResponse.json({ error: "Missing suggestions array" }, { status: 400 });
  }
  const suggestions = body.suggestions.filter(isSuggestion).map((s) => ({
    symbol: s.symbol.trim().toUpperCase(),
    companyName: s.companyName || s.symbol,
    rationale: s.rationale || "",
  }));
  if (suggestions.length === 0) {
    return NextResponse.json({ error: "No valid suggestions in request" }, { status: 400 });
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

  const { verdicts } = await filterAndQueueSuggestions({ userId, themeId, suggestions });
  return NextResponse.json({ verdicts });
}
