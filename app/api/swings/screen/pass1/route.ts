import { NextResponse } from "next/server";
import { pass1Filter, serializePass1 } from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";

export const dynamic = "force-dynamic";
// Pass 1 is batched Yahoo /quote + quoteSummary across the ~580-symbol
// SWING_UNIVERSE. Hobby plan caps function duration at 60s, so a cold
// run with retries can clip; the swing-screener handles partial Pass 1
// gracefully — survivors are computed from whatever Yahoo returned.
export const maxDuration = 60;

export async function POST(): Promise<NextResponse> {
  const started = Date.now();
  const result = await pass1Filter(SWING_UNIVERSE);
  const wire = serializePass1(result, SWING_UNIVERSE.length);
  return NextResponse.json({
    ...wire,
    durationMs: Date.now() - started,
  });
}
