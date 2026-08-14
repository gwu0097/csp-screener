import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getValidAccessToken, forceRefreshToken } from "@/lib/schwab";
import { requireAdmin, authErrorResponse } from "@/lib/auth";
import { evaluateSchwabTokenWarning } from "@/lib/schwab-token-warning";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/schwab/token-status[?verify=1]
//
// Surface the age of the Schwab refresh token so the UI can show a
// proactive banner BEFORE the token expires (Schwab refresh tokens
// have a 7-day TTL — currently the user only finds out when every
// API call starts failing). All the data we need is already on the
// schwab_tokens row from lib/schwab.persistTokens; this just reads
// it and computes derived status fields.
//
// Without ?verify=1: only exercises a live refresh when the ACCESS
// token itself is already past its 30-min TTL — cheap, but can go a
// full week without ever proving the refresh token still works.
//
// With ?verify=1 (used by the dashboard banner, which must clear
// ONLY on a verified successful refresh, never merely because the
// OAuth redirect landed): unconditionally attempts a live refresh via
// forceRefreshToken(), the same path the weekend health job uses, so
// "connected" here means "Schwab accepted this token just now," not
// "a locally-computed timestamp hasn't passed yet."
//
// status:
//   "missing"          no row in schwab_tokens — never connected
//   "expired"          refresh_token_expires_at <= now
//   "refresh_failed"   live refresh attempted and failed
//   "ok"               none of the above (may still have shouldWarn=true —
//                      see below)
//
// shouldWarn/warningClause/warningMessage: the SINGLE source of truth
// for whether/why/what to tell the user about reconnecting, computed by
// lib/schwab-token-warning.evaluateSchwabTokenWarning — every frontend
// surface (dashboard banner, screener badge) renders these directly
// instead of re-deriving its own days-remaining threshold. Only
// evaluated when the token is otherwise valid (missing/refresh_failed
// stay their own always-shown failure states, independent of the
// weekend-cycle clauses).

type StatusKind = "missing" | "expired" | "refresh_failed" | "ok";

type WarningFields = {
  shouldWarn: boolean;
  warningClause: 1 | 2 | 3 | 4 | null;
  warningMessage: string;
};

const NO_WARNING: WarningFields = { shouldWarn: false, warningClause: null, warningMessage: "" };

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Admin-only, like every other Schwab route: the response carries
  // token lifecycle metadata and can trigger a live token refresh.
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const verify = req.nextUrl.searchParams.get("verify") === "1";

  if (verify) {
    const result = await forceRefreshToken();
    if (!result.ok) {
      return NextResponse.json({
        valid: false,
        status: (result.error === "not_connected" ? "missing" : "refresh_failed") as StatusKind,
        expiresAt: result.hadStoredExpiry,
        expiresInDays: result.daysRemainingBeforeAttempt,
        ageHours: null,
        refreshAttempted: true,
        refreshError: result.error,
        liveVerified: false,
        liveVerifiedAt: null,
        ...NO_WARNING,
      });
    }
    const now = new Date();
    // A verify success just refreshed the token this instant — pass
    // `now` as lastRefreshedAt so clause 3's 24h suppression correctly
    // treats this as freshly reconnected (nothing to warn about right
    // after a successful reconnect).
    const warning = evaluateSchwabTokenWarning({
      expiresAt: result.newRefreshExpiresAt,
      lastRefreshedAt: now,
      now,
    });
    const expiresInDays = (new Date(result.newRefreshExpiresAt).getTime() - now.getTime()) / DAY_MS;
    return NextResponse.json({
      valid: true,
      status: "ok" as StatusKind,
      expiresAt: result.newRefreshExpiresAt,
      expiresInDays: Number(expiresInDays.toFixed(2)),
      ageHours: 0,
      refreshAttempted: true,
      refreshError: null,
      liveVerified: true,
      liveVerifiedAt: now.toISOString(),
      shouldWarn: warning.shouldWarn,
      warningClause: warning.clause,
      warningMessage: warning.message,
    });
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
        ...NO_WARNING,
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
      ...NO_WARNING,
    });
  }

  const now = new Date();
  const nowMs = now.getTime();
  const expiry = new Date(row.refresh_token_expires_at).getTime();
  const refreshedAt = new Date(row.updated_at).getTime();
  const expiresInMs = expiry - nowMs;
  const expiresInDays = expiresInMs / DAY_MS;
  const ageHours = (nowMs - refreshedAt) / (60 * 60 * 1000);

  let status: StatusKind = expiresInMs <= 0 ? "expired" : "ok";
  // evaluateSchwabTokenWarning already treats "already expired" as
  // clause 4 — no special-casing needed here, it's called
  // unconditionally and produces the right message either way.
  const warning = evaluateSchwabTokenWarning({
    expiresAt: row.refresh_token_expires_at,
    lastRefreshedAt: row.updated_at,
    now,
  });

  // Access-side check. Schwab access tokens are 30-minute TTL; the
  // normal lifecycle is "expired most of the time, refreshed on
  // demand by getValidAccessToken." We only surface here when the
  // refresh side itself fails — i.e., access is past expiry AND
  // calling getValidAccessToken throws. That's the "auto-refresh
  // is broken" signal the banner needs to flag.
  const accessExpiry = new Date(row.access_token_expires_at).getTime();
  const accessExpired = accessExpiry <= nowMs;
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
    liveVerified: false,
    liveVerifiedAt: null,
    // status can flip to "refresh_failed" above, after `warning` was
    // already computed — deliberate: a live refresh_failed always wins
    // in the UI (each component checks status first), so a stale
    // clause-based message alongside it is harmless, never shown.
    shouldWarn: warning.shouldWarn,
    warningClause: warning.clause,
    warningMessage: warning.message,
  });
}

const DAY_MS = 86_400_000;
