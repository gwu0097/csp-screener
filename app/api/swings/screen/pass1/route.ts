import { NextResponse } from "next/server";
import { pass1Filter, serializePass1 } from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";

export const dynamic = "force-dynamic";
// Pass 1 is just batched Yahoo /quote + quoteSummary; the full ~580-symbol
// universe takes ~15-25s end-to-end and stays well under the default 60s
// Vercel function ceiling.

export async function POST(): Promise<NextResponse> {
  const started = Date.now();
  const result = await pass1Filter(SWING_UNIVERSE);
  const wire = serializePass1(result, SWING_UNIVERSE.length);
  return NextResponse.json({
    ...wire,
    durationMs: Date.now() - started,
  });
}
