import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getUserByEmail,
  sessionCookieOptions,
  signSession,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  const user = await getUserByEmail(email);
  const ok =
    user !== null &&
    user.password_hash !== null &&
    verifyPassword(password, user.password_hash);
  if (!ok) {
    // Uniform delay + message: don't leak which of email/password failed.
    await sleep(600);
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 },
    );
  }

  const token = await signSession({
    id: user!.id,
    role: user!.role,
    name: user!.name,
  });
  const res = NextResponse.json({
    user: { id: user!.id, name: user!.name, role: user!.role },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
