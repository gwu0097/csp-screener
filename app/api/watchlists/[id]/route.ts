// Rename / delete a single watchlist. Portfolio (is_portfolio=true)
// is protected — never renameable or deletable through this route.
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import type { WatchlistMeta } from "@/lib/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PatchBody = { name?: unknown };

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
  const id = params.id;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json({ error: "Name too long" }, { status: 400 });
  }

  const sb = createServerClient();
  const existing = await sb
    .from("watchlists")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing.error || !existing.data) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }
  const w = existing.data as WatchlistMeta;
  if (w.is_portfolio) {
    return NextResponse.json(
      { error: "Portfolio can't be renamed" },
      { status: 403 },
    );
  }
  if (name.toLowerCase() === "portfolio") {
    return NextResponse.json(
      { error: "\"Portfolio\" is reserved for the built-in watchlist" },
      { status: 409 },
    );
  }

  const res = await sb
    .from("watchlists")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) {
    const status = res.error.code === "23505" ? 409 : 400;
    return NextResponse.json(
      { error: status === 409 ? "A watchlist with that name already exists" : res.error.message },
      { status },
    );
  }
  return NextResponse.json({ watchlist: res.data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = params.id;

  const sb = createServerClient();
  const existing = await sb
    .from("watchlists")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing.error || !existing.data) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }
  const w = existing.data as WatchlistMeta;
  if (w.is_portfolio) {
    return NextResponse.json(
      { error: "Portfolio can't be deleted" },
      { status: 403 },
    );
  }

  // Items cascade via the watchlist_id FK (ON DELETE CASCADE).
  const res = await sb.from("watchlists").delete().eq("id", id).eq("user_id", userId);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
