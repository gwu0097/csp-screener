import { NextResponse } from "next/server";
import { disconnectSchwabAcct, getSchwabAcctAuthUrl, checkAcctEnv } from "@/lib/schwab-account";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// OAuth entry point for the "Account Data" Schwab app (Accounts and
// Trading Production) — separate registration, separate token storage
// (lib/schwab-account.ts), from the market-data connection at
// /api/auth/schwab. Admin-only, same as that route.
export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const env = checkAcctEnv();
  // Presence only — never the values themselves.
  console.log("[schwab-acct-auth] env check:", env);
  const url = getSchwabAcctAuthUrl();
  console.log("[schwab-acct-auth] redirecting to authorize URL (path only):", new URL(url).pathname);
  return NextResponse.redirect(url);
}

export async function DELETE() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  try {
    await disconnectSchwabAcct();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
