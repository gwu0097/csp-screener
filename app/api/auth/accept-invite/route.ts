import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  hashPassword,
  sessionCookieOptions,
  signSession,
} from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Public (token-gated): an invitee sets their password and gets a
// session in one step. Tokens are single-use and expire after 7 days.
export async function POST(req: NextRequest) {
  let body: { token?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token || !/^[a-f0-9]{48}$/.test(token)) {
    return NextResponse.json({ error: "Invalid invite link" }, { status: 400 });
  }
  if (password.length < 10) {
    return NextResponse.json(
      { error: "Password must be at least 10 characters" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const r = await sb
    .from("users")
    .select("*")
    .eq("invite_token", token)
    .maybeSingle();
  const user = r.data as
    | {
        id: string;
        name: string;
        role: "admin" | "member";
        invite_expires_at: string | null;
        password_hash: string | null;
      }
    | null;
  if (r.error || !user) {
    return NextResponse.json(
      { error: "Invite not found — ask for a new link" },
      { status: 404 },
    );
  }
  if (
    user.invite_expires_at &&
    new Date(user.invite_expires_at).getTime() < Date.now()
  ) {
    return NextResponse.json(
      { error: "Invite expired — ask for a new link" },
      { status: 410 },
    );
  }

  const upd = await sb
    .from("users")
    .update({
      password_hash: hashPassword(password),
      invite_token: null,
      invite_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 });
  }

  const session = await signSession({
    id: user.id,
    role: user.role,
    name: user.name,
  });
  const res = NextResponse.json({
    user: { id: user.id, name: user.name, role: user.role },
  });
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return res;
}
