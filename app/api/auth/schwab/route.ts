import { NextResponse } from "next/server";
import { disconnectSchwab, getSchwabAuthUrl } from "@/lib/schwab";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = getSchwabAuthUrl();
  console.log("[schwab-auth] redirecting to authorize URL:", url);
  console.log("[schwab-auth] env check:", {
    clientIdPresent: Boolean(process.env.SCHWAB_CLIENT_ID),
    clientSecretPresent: Boolean(process.env.SCHWAB_CLIENT_SECRET),
    redirectUri: process.env.SCHWAB_REDIRECT_URI,
  });
  return NextResponse.redirect(url);
}

export async function DELETE() {
  try {
    await disconnectSchwab();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
