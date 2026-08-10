import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase A — theme-level list/create. Member CRUD lives
// under [id]/members. No screener wiring here (Phase B) and no
// Perplexity expansion (Phase C) — this is manual curation storage only.

type ThemeRow = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type MemberCountRow = { theme_id: string; is_anchor: boolean; is_active: boolean };

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const themesRes = await sb
    .from<ThemeRow>("themes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (themesRes.error) {
    return NextResponse.json({ error: themesRes.error.message }, { status: 500 });
  }
  const themes = (themesRes.data ?? []) as ThemeRow[];

  // Member/anchor counts — one bulk query across every theme rather than
  // N+1. The wrapper has no aggregate/count support, so counts are
  // computed here from the raw rows.
  const themeIds = themes.map((t) => t.id);
  const counts = new Map<string, { members: number; anchors: number }>();
  if (themeIds.length > 0) {
    const membersRes = await sb
      .from<MemberCountRow>("theme_members")
      .select("theme_id,is_anchor,is_active")
      .eq("user_id", userId)
      .in("theme_id", themeIds);
    if (!membersRes.error) {
      for (const row of (membersRes.data ?? []) as MemberCountRow[]) {
        if (!row.is_active) continue;
        const cur = counts.get(row.theme_id) ?? { members: 0, anchors: 0 };
        cur.members += 1;
        if (row.is_anchor) cur.anchors += 1;
        counts.set(row.theme_id, cur);
      }
    }
  }

  return NextResponse.json({
    themes: themes.map((t) => ({
      ...t,
      memberCount: counts.get(t.id)?.members ?? 0,
      anchorCount: counts.get(t.id)?.anchors ?? 0,
    })),
  });
}

type CreateBody = {
  name?: unknown;
  description?: unknown;
  theme_type?: unknown;
};

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from<ThemeRow>("themes")
    .insert({
      user_id: userId,
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      theme_type: typeof body.theme_type === "string" ? body.theme_type.trim() || null : null,
    })
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ theme: res.data });
}
