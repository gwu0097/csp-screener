import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { runExpansionSuggest } from "@/lib/theme-expansion";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase C — stage 1 of expansion: one bounded
// Perplexity call, no hard filtering yet (see ../filter for stage 2).
// Split from filtering specifically to stay inside Vercel's function
// time ceiling — see lib/theme-expansion.ts's header comment.
export const maxDuration = 60;

type ThemeRow = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  expansion_prompt: string | null;
};
type AnchorRow = { symbol: string };
type MemberSymbolRow = { symbol: string };

type Body = { promptOverride?: unknown };

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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine — re-running with the theme's saved prompt
  }
  const promptOverride = typeof body.promptOverride === "string" ? body.promptOverride : null;

  const sb = createServerClient();
  const themeRes = await sb
    .from<ThemeRow>("themes")
    .select("id,name,description,theme_type,expansion_prompt")
    .eq("id", themeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  if (!themeRes.data) return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  const theme = themeRes.data;

  const [anchorsRes, membersRes] = await Promise.all([
    sb
      .from<AnchorRow>("theme_members")
      .select("symbol")
      .eq("theme_id", themeId)
      .eq("user_id", userId)
      .eq("is_anchor", true)
      .eq("is_active", true),
    sb
      .from<MemberSymbolRow>("theme_members")
      .select("symbol")
      .eq("theme_id", themeId)
      .eq("user_id", userId),
  ]);
  const anchorSymbols = ((anchorsRes.data ?? []) as AnchorRow[]).map((r) => r.symbol);
  const existingSymbols = ((membersRes.data ?? []) as MemberSymbolRow[]).map((r) => r.symbol);

  // If the caller sent an edited prompt, persist it now — "editable per-
  // theme so the user can refine it" means the refinement survives past
  // this one run.
  if (promptOverride !== null && promptOverride.trim() !== (theme.expansion_prompt ?? "")) {
    await sb
      .from("themes")
      .update({ expansion_prompt: promptOverride.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", themeId)
      .eq("user_id", userId);
  }

  const result = await runExpansionSuggest({
    themeType: theme.theme_type,
    promptOverride: promptOverride ?? theme.expansion_prompt,
    anchors: anchorSymbols.map((symbol) => ({ symbol, companyName: null })),
    description: theme.description,
    existingSymbols,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    suggestions: result.suggestions,
    rawCount: result.rawCount,
    truncated: result.truncated,
  });
}
