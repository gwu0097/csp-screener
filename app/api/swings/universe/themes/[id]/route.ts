import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { enrichSymbols } from "@/lib/universe";
import { listThemeRejections } from "@/lib/theme-expansion";

export const dynamic = "force-dynamic";

type ThemeRow = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  expansion_prompt: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  id: string;
  symbol: string;
  is_anchor: boolean;
  source: string;
  added_at: string;
  is_active: boolean;
  notes: string | null;
  review_status: string;
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
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const sb = createServerClient();
  const themeRes = await sb
    .from<ThemeRow>("themes")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (themeRes.error) {
    return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  }
  if (!themeRes.data) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }

  // Every member, active and inactive — the UI's default view filters to
  // active; reactivating a deactivated member needs the full record
  // still reachable, not deleted.
  const membersRes = await sb
    .from<MemberRow>("theme_members")
    .select("*")
    .eq("theme_id", id)
    .eq("user_id", userId)
    .order("is_anchor", { ascending: false })
    .order("symbol", { ascending: true });
  if (membersRes.error) {
    return NextResponse.json({ error: membersRes.error.message }, { status: 500 });
  }
  const members = (membersRes.data ?? []) as MemberRow[];

  // Cache-only enrichment — a page view must never trigger a live fetch.
  const enrichment = await enrichSymbols(members.map((m) => m.symbol));

  // Full rejection history, each row flagged against the theme's CURRENT
  // theme_type/expansion_prompt — powers both the "Rejected (N)" panel
  // and the stale-rejection banner (rejections.filter(r =>
  // !r.is_current_scope) on the client). Computed on every page load
  // rather than only right after an edit, so the notice is correct
  // regardless of where theme_type was changed (the list page's edit
  // dialog, not this detail page) or how long ago.
  const rejections = await listThemeRejections(userId, id, {
    themeType: themeRes.data.theme_type,
    expansionPromptOverride: themeRes.data.expansion_prompt,
  });

  return NextResponse.json({
    theme: themeRes.data,
    members: members.map((m) => ({
      ...m,
      ...(enrichment.get(m.symbol.toUpperCase()) ?? {
        companyName: null,
        price: null,
        marketCap: null,
        sector: null,
        adr20Pct: null,
      }),
    })),
    rejections,
  });
}

type PatchBody = {
  name?: unknown;
  description?: unknown;
  theme_type?: unknown;
  is_active?: unknown;
  expansion_prompt?: unknown;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string") {
    if (body.name.trim().length === 0) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (body.theme_type !== undefined) {
    patch.theme_type = typeof body.theme_type === "string" ? body.theme_type.trim() || null : null;
  }
  if (typeof body.is_active === "boolean") {
    patch.is_active = body.is_active;
  }
  if (body.expansion_prompt !== undefined) {
    patch.expansion_prompt = typeof body.expansion_prompt === "string" ? body.expansion_prompt.trim() || null : null;
  }

  const sb = createServerClient();
  const res = await sb
    .from<ThemeRow>("themes")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ theme: res.data });
}
