import { NextResponse } from "next/server";
import { runScreener } from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const data = await runScreener();
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ connected: false, results: [], errors: [msg] }, { status: 500 });
  }
}
