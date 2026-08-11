import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Multi-query fan-out (see lib/theme-expansion.ts's buildFullPrompt
// subQueryFocus param) -- one "Run expansion" click sequentially calls
// Perplexity once per sub-query, so the cap bounds cost/runtime, not
// storage. Enforced here at create time; the run loop also defensively
// slices to the first 8.
const MAX_SUBQUERIES = 8;

type SubqueryRow = {
  id: string;
  theme_id: string;
  name: string;
  query_text: string;
  anchor_symbols: string[] | null;
  sort_order: number;
  created_at: string;
};

export async function GET(
  _req: NextRequest,
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

  const sb = createServerClient();
  const res = await sb
    .from<SubqueryRow>("theme_subqueries")
    .select("*")
    .eq("theme_id", themeId)
    .eq("user_id", userId)
    .order("sort_order", { ascending: true });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ subqueries: res.data ?? [] });
}

type PostBody = { name?: unknown; query_text?: unknown; anchor_symbols?: unknown };

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

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const queryText = typeof body.query_text === "string" ? body.query_text.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!queryText) return NextResponse.json({ error: "query_text (the angle) is required" }, { status: 400 });
  const anchorSymbols = Array.isArray(body.anchor_symbols)
    ? Array.from(
        new Set(
          body.anchor_symbols
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0),
        ),
      )
    : null;

  const sb = createServerClient();
  const themeRes = await sb.from("themes").select("id").eq("id", themeId).eq("user_id", userId).maybeSingle();
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  if (!themeRes.data) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

  const countRes = await sb
    .from("theme_subqueries")
    .select("id")
    .eq("theme_id", themeId)
    .eq("user_id", userId);
  if (countRes.error) return NextResponse.json({ error: countRes.error.message }, { status: 500 });
  const currentCount = (countRes.data ?? []).length;
  if (currentCount >= MAX_SUBQUERIES) {
    return NextResponse.json(
      { error: `A theme can have at most ${MAX_SUBQUERIES} sub-queries (bounds cost/runtime of one fan-out run)` },
      { status: 400 },
    );
  }

  const ins = await sb
    .from<SubqueryRow>("theme_subqueries")
    .insert({
      theme_id: themeId,
      user_id: userId,
      name,
      query_text: queryText,
      anchor_symbols: anchorSymbols && anchorSymbols.length > 0 ? anchorSymbols : null,
      sort_order: currentCount,
    })
    .select()
    .single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  return NextResponse.json({ subquery: ins.data });
}
