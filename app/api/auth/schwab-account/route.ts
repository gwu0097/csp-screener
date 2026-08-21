import { NextRequest, NextResponse } from "next/server";
import { disconnectSchwabAcct, getSchwabAcctAuthUrl, checkAcctEnv, CHAIN_BOTH_STATE } from "@/lib/schwab-account";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// OAuth entry point for the "Account Data" Schwab app (Accounts and
// Trading Production) — separate registration, separate token storage
// (lib/schwab-account.ts), from the market-data connection at
// /api/auth/schwab. Admin-only, same as that route.
//
// ?chain=1 — the market-data callback lands here as the second leg of
// "Reconnect both" after its own exchange succeeded. Tag this leg's
// state too so callback/route.ts knows to report both connections at
// once instead of just this one.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const env = checkAcctEnv();
  // Presence only — never the values themselves.
  console.log("[schwab-acct-auth] env check:", env);
  const chained = req.nextUrl.searchParams.get("chain") === "1";
  const url = getSchwabAcctAuthUrl(chained ? CHAIN_BOTH_STATE : undefined);
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
