import { NextRequest, NextResponse } from "next/server";
import {
  authErrorResponse,
  getUserById,
  hashPassword,
  requireUser,
  verifyPassword,
} from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireUser();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const current =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (next.length < 10) {
    return NextResponse.json(
      { error: "New password must be at least 10 characters" },
      { status: 400 },
    );
  }
  const user = await getUserById(session.id);
  if (!user?.password_hash || !verifyPassword(current, user.password_hash)) {
    return NextResponse.json(
      { error: "Current password is incorrect" },
      { status: 403 },
    );
  }
  const sb = createServerClient();
  const upd = await sb
    .from("users")
    .update({
      password_hash: hashPassword(next),
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
