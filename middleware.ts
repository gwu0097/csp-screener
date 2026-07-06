// Session gate for every page and API route. Verifies the HS256
// session cookie (edge-safe via jose), forwards the identity to route
// handlers via x-user-* request headers (after stripping any spoofed
// inbound values), and slides the cookie expiry on tokens older than
// 7 days. Unauthenticated: API calls get 401 JSON, pages redirect to
// /login.
import { NextRequest, NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";

const SESSION_COOKIE = "csp_session";
const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const RENEW_AFTER_S = 7 * 24 * 3600;

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/accept-invite",
  // Cron capture endpoints — no session cookie; each route fails closed
  // on its own CRON_SECRET bearer check (lib/cron-auth.ts).
  "/api/earnings/capture-t0",
  "/api/earnings/capture-t1",
]);

function secret(): Uint8Array {
  return new TextEncoder().encode(process.env.AUTH_SECRET ?? "");
}

function stripIdentityHeaders(req: NextRequest): Headers {
  const h = new Headers(req.headers);
  h.delete("x-user-id");
  h.delete("x-user-role");
  h.delete("x-user-name");
  return h;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next({
      request: { headers: stripIdentityHeaders(req) },
    });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  type SessionPayload = {
    sub?: string;
    role?: unknown;
    name?: unknown;
    iat?: number;
  };
  let payload: SessionPayload | null = null;
  if (token) {
    try {
      const v = await jwtVerify(token, secret());
      payload = v.payload as unknown as SessionPayload;
    } catch {
      payload = null;
    }
  }
  const sub = payload?.sub;
  const role = payload?.role;
  if (!sub || (role !== "admin" && role !== "member")) {
    if (isApi) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search =
      pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }

  const headers = stripIdentityHeaders(req);
  headers.set("x-user-id", sub);
  headers.set("x-user-role", role);
  headers.set(
    "x-user-name",
    typeof payload?.name === "string" ? payload.name : "",
  );
  const res = NextResponse.next({ request: { headers } });

  // Sliding renewal: re-issue when the token is past 7 days old so an
  // active user never gets logged out.
  const iat = payload?.iat ?? 0;
  if (iat > 0 && Date.now() / 1000 - iat > RENEW_AFTER_S) {
    try {
      const renewed = await new SignJWT({
        role,
        name: typeof payload?.name === "string" ? payload.name : "",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_MAX_AGE_S}s`)
        .sign(secret());
      res.cookies.set(SESSION_COOKIE, renewed, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_S,
      });
    } catch {
      /* renewal is best-effort */
    }
  }
  return res;
}

export const config = {
  // Everything except Next internals and static assets. API routes ARE
  // matched — that's the point.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|fonts/).*)"],
};
