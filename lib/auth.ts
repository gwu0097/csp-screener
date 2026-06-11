// Session auth for the known-users multi-tenancy model.
//
// - Passwords: scrypt (node:crypto, no extra dependency), stored as
//   "scrypt$N$r$p$saltB64$hashB64" in users.password_hash.
// - Sessions: HS256 JWT (jose) in an HTTP-only cookie. middleware.ts
//   verifies it on every request and forwards the identity via
//   x-user-* request headers, so route handlers read headers()
//   instead of re-verifying.
// - Personal-data scoping: route handlers call requireUserId() and
//   filter every personal-table query by it. Shared market/research
//   tables are untouched.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { createServerClient } from "@/lib/supabase";

export const SESSION_COOKIE = "csp_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600; // 30 days, sliding

export type Role = "admin" | "member";
export type SessionUser = { id: string; role: Role; name: string };

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: Role;
  invite_token: string | null;
  invite_expires_at: string | null;
};

function authSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET ?? "";
  if (s.length < 32) throw new Error("AUTH_SECRET missing or too short");
  return new TextEncoder().encode(s);
}

// ---------- passwords ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- session tokens ----------

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ role: user.role, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_S}s`)
    .sign(authSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret());
    const id = payload.sub;
    const role = payload.role;
    if (typeof id !== "string" || (role !== "admin" && role !== "member")) {
      return null;
    }
    return {
      id,
      role,
      name: typeof payload.name === "string" ? payload.name : "",
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  };
}

// ---------- request identity (route handlers / server components) ----------

// middleware.ts verifies the cookie and forwards identity via these
// headers (stripping any spoofed inbound values first). The cookie
// fallback covers server components rendered outside the middleware
// matcher and direct calls in dev.
export async function getSessionUser(): Promise<SessionUser | null> {
  const h = headers();
  const id = h.get("x-user-id");
  const role = h.get("x-user-role");
  if (id && (role === "admin" || role === "member")) {
    return { id, role, name: h.get("x-user-name") ?? "" };
  }
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) throw new AuthError(401, "Not signed in");
  return u;
}

export async function requireUserId(): Promise<string> {
  return (await requireUser()).id;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "admin") {
    throw new AuthError(403, "Admin only");
  }
  return u;
}

// Translate an AuthError into the JSON response routes must return;
// rethrows anything else.
export function authErrorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  throw e;
}

// ---------- user lookups ----------

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const sb = createServerClient();
  const r = await sb
    .from("users")
    .select("*")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  if (r.error) return null;
  return (r.data as UserRow) ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const sb = createServerClient();
  const r = await sb.from("users").select("*").eq("id", id).maybeSingle();
  if (r.error) return null;
  return (r.data as UserRow) ?? null;
}
