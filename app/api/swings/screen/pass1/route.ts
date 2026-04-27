import { NextResponse } from "next/server";
import { pass1Filter, serializePass1 } from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";

export const dynamic = "force-dynamic";
// Pass 1 is batched Yahoo /quote + quoteSummary across the ~580-symbol
// SWING_UNIVERSE. Cold runs and Yahoo's occasional rate-limit retries
// can push past 60s, so we sit at the Pro-plan 300s ceiling — same
// budget the predecessor /swings/screen route used before the split.
export const maxDuration = 300;

export async function POST(): Promise<NextResponse> {
  const started = Date.now();
  const result = await pass1Filter(SWING_UNIVERSE);
  const wire = serializePass1(result, SWING_UNIVERSE.length);
  return NextResponse.json({
    ...wire,
    durationMs: Date.now() - started,
  });
}
