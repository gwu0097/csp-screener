import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getValidAcctAccessToken, forceRefreshAcctToken } from "@/lib/schwab-account";
import { requireAdmin, authErrorResponse } from "@/lib/auth";
import { evaluateSchwabTokenWarning } from "@/lib/schwab-token-warning";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/schwab-account/token-status[?verify=1]
//
// Same shape and same reasoning as /api/schwab/token-status — mirrored
// deliberately rather than parameterizing one route over both
// connections, matching lib/schwab-account.ts's own isolation stance:
// a bug in this route can't touch the market-data token status, and
// vice versa. evaluateSchwabTokenWarning (lib/schwab-token-warning.ts)
// is genuinely generic — same weekend-aware clause logic reused
// as-is, just fed this connection's own expiry/refresh timestamps
// from schwab_account_tokens instead of schwab_tokens.
type StatusKind = "missing" | "expired" | "refresh_failed" | "ok";

type WarningFields = {
  shouldWarn: boolean;
  warningClause: 2 | 3 | 4 | null;
  warningMessage: string;
};

const NO_WARNING: WarningFields = { shouldWarn: false, warningClause: null, warningMessage: "" };
const DAY_MS = 86_400_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const verify = req.nextUrl.searchParams.get("verify") === "1";

  if (verify) {
    const result = await forceRefreshAcctToken();
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
    .from("schwab_account_tokens")
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
  const warning = evaluateSchwabTokenWarning({
    expiresAt: row.refresh_token_expires_at,
    lastRefreshedAt: row.updated_at,
    now,
  });

  const accessExpiry = new Date(row.access_token_expires_at).getTime();
  const accessExpired = accessExpiry <= nowMs;
  let refreshAttempted = false;
  let refreshError: string | null = null;
  if (accessExpired && status !== "expired") {
    refreshAttempted = true;
    try {
      await getValidAcctAccessToken();
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
    shouldWarn: warning.shouldWarn,
    warningClause: warning.clause,
    warningMessage: warning.message,
  });
}
