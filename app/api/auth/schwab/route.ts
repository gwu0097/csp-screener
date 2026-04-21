import { NextResponse } from "next/server";
import { disconnectSchwab, getSchwabAuthUrl } from "@/lib/schwab";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.redirect(getSchwabAuthUrl());
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
