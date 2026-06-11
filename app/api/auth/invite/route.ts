import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authErrorResponse, requireAdmin } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Admin-only: create (or re-invite) a member and return the invite
// link to share out-of-band. The invitee sets their password at
// /login?invite=TOKEN within 7 days.
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: { email?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
  const sb = createServerClient();

  const existing = await sb
    .from("users")
    .select("id, password_hash")
    .eq("email", email)
    .maybeSingle();
  if (existing.data?.password_hash) {
    return NextResponse.json(
      { error: "That user already has an account" },
      { status: 409 },
    );
  }
  const write = existing.data
    ? await sb
        .from("users")
        .update({
          name: name || undefined,
          invite_token: token,
          invite_expires_at: expires,
          updated_at: new Date().toISOString(),
        })
        .eq("id", (existing.data as { id: string }).id)
    : await sb.from("users").insert({
        email,
        name,
        role: "member",
        invite_token: token,
        invite_expires_at: expires,
      });
  if (write.error) {
    return NextResponse.json({ error: write.error.message }, { status: 500 });
  }

  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    req.nextUrl.origin;
  return NextResponse.json({
    inviteUrl: `${base}/login?invite=${token}`,
    expiresAt: expires,
  });
}
