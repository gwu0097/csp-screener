import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getValidAccessToken } from "@/lib/schwab";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/schwab/token-status
//
// Surface the age of the Schwab refresh token so the UI can show a
// proactive banner BEFORE the token expires (Schwab refresh tokens
// have a 7-day TTL — currently the user only finds out when every
// API call starts failing). All the data we need is already on the
// schwab_tokens row from lib/schwab.persistTokens; this just reads
// it and computes derived status fields.
//
// When the access token is past expiry but refresh is still valid
// we ALSO exercise getValidAccessToken so a Schwab-side refresh
// failure (rotated refresh token, network blip, etc.) surfaces
// here as "refresh_failed" instead of silently failing the next
// chain fetch.
//
// status:
//   "missing"          no row in schwab_tokens — never connected
//   "expired"          refresh_token_expires_at <= now
//   "refresh_failed"   access expired AND auto-refresh threw
//   "warning"          < 2 days remaining on refresh
//   "soft_warn"        < 3 days remaining on refresh
//   "ok"               > 3 days remaining

type StatusKind =
  | "missing"
  | "expired"
  | "refresh_failed"
  | "warning"
  | "soft_warn"
  | "ok";

const DAY_MS = 86_400_000;

export async function GET(): Promise<NextResponse> {
  // Admin-only, like every other Schwab route: the response carries
  // token lifecycle metadata and can trigger a live token refresh.
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const r = await sb
    .from("schwab_tokens")
    .select("refresh_token_expires_at, updated_at, access_token_expires_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (r.error) {
    return NextResponse.json(
      {
        valid: false,
        status: "missing" as StatusKind,
        error: r.error.message,
        expiresAt: null,
        expiresInDays: null,
        ageHours: null,
      },
      { status: 200 },
    );
  }
  const rows = (r.data ?? []) as Array<{
    refresh_token_expires_at: string;
    updated_at: string;
    access_token_expires_at: string;
  }>;
  const row = rows[0];
  if (!row) {
    return NextResponse.json({
      valid: false,
      status: "missing" as StatusKind,
      expiresAt: null,
      expiresInDays: null,
      ageHours: null,
    });
  }

  const now = Date.now();
  const expiry = new Date(row.refresh_token_expires_at).getTime();
  const refreshedAt = new Date(row.updated_at).getTime();
  const expiresInMs = expiry - now;
  const expiresInDays = expiresInMs / DAY_MS;
  const ageHours = (now - refreshedAt) / (60 * 60 * 1000);

  let status: StatusKind;
  if (expiresInMs <= 0) status = "expired";
  else if (expiresInDays < 1) status = "warning"; // < 24 hrs
  else if (expiresInDays < 2) status = "warning"; // 1-2 days (orange)
  else if (expiresInDays < 3) status = "soft_warn"; // 2-3 days (yellow)
  else status = "ok";

  // Access-side check. Schwab access tokens are 30-minute TTL; the
  // normal lifecycle is "expired most of the time, refreshed on
  // demand by getValidAccessToken." We only surface here when the
  // refresh side itself fails — i.e., access is past expiry AND
  // calling getValidAccessToken throws. That's the "auto-refresh
  // is broken" signal the banner needs to flag.
  const accessExpiry = new Date(row.access_token_expires_at).getTime();
  const accessExpired = accessExpiry <= now;
  let refreshAttempted = false;
  let refreshError: string | null = null;
  if (accessExpired && status !== "expired") {
    refreshAttempted = true;
    try {
      await getValidAccessToken();
    } catch (e) {
      refreshError = e instanceof Error ? e.message : "refresh failed";
      status = "refresh_failed";
    }
  }

  return NextResponse.json({
    valid: status !== "expired" && status !== "refresh_failed",
    status,
    expiresAt: row.refresh_token_expires_at,
    expiresInDays: Number(expiresInDays.toFixed(2)),
    ageHours: Number(ageHours.toFixed(1)),
    accessExpiresAt: row.access_token_expires_at,
    accessExpired,
    refreshAttempted,
    refreshError,
  });
}
