import { NextResponse } from "next/server";
import { runAutoExpire } from "@/lib/expire-positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Runs the auto-expire sweep: closes clearly-worthless positions in
// place, returns the residual needs_verification + pending list so the
// UI can warn the user. No body needed — scope is every open position
// whose expiry is strictly in the past.
export async function POST() {
  const report = await runAutoExpire();
  return NextResponse.json(report);
}
