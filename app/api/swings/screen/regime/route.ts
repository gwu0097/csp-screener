import { NextResponse } from "next/server";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";
import { computeEMA } from "@/lib/indicators";

export const dynamic = "force-dynamic";

// Display-only market regime for SPY/QQQ — feeds the swing journal's
// market_regime field at entry time (see swing-trade-dialog.tsx), never
// gates the screener. Independent of the pass1/pass2/pass3 pipeline so it
// can refresh on its own without waiting on a full scan.

// "Rising" lookback for the 21 EMA — not specified in the setup spec (only
// the 50MA-rising trend filter names an explicit 20-session lookback);
// 5 sessions is a short, responsive window appropriate for a "what's the
// regime right now" label rather than a multi-week trend confirmation.
const EMA21_RISING_LOOKBACK_SESSIONS = 5;

type IndexRegime = {
  ema8: number | null;
  ema21: number | null;
  ema21Rising: boolean | null;
  state: "uptrend" | "downtrend" | "mixed" | "unknown";
};

async function regimeFor(symbol: string): Promise<IndexRegime> {
  const bars = await getOrFetchDailyBars(symbol).catch(() => []);
  const closes = bars.map((b) => b.close);
  const ema8Series = computeEMA(closes, 8);
  const ema21Series = computeEMA(closes, 21);
  const ema8 = ema8Series[ema8Series.length - 1] ?? null;
  const ema21 = ema21Series[ema21Series.length - 1] ?? null;
  const ema21Prior =
    ema21Series.length > EMA21_RISING_LOOKBACK_SESSIONS
      ? ema21Series[ema21Series.length - 1 - EMA21_RISING_LOOKBACK_SESSIONS]
      : null;
  const ema21Rising = ema21 !== null && ema21Prior !== null ? ema21 > ema21Prior : null;

  if (ema8 === null || ema21 === null || ema21Rising === null) {
    return { ema8, ema21, ema21Rising, state: "unknown" };
  }
  const state: IndexRegime["state"] =
    ema8 > ema21 && ema21Rising
      ? "uptrend"
      : ema8 < ema21 && !ema21Rising
        ? "downtrend"
        : "mixed";
  return { ema8, ema21, ema21Rising, state };
}

export async function GET(): Promise<NextResponse> {
  try {
    const [spy, qqq] = await Promise.all([regimeFor("SPY"), regimeFor("QQQ")]);
    const label = `SPY ${spy.state} / QQQ ${qqq.state}`;
    return NextResponse.json({ spy, qqq, label });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "regime failed";
    console.error("[swings/regime] failed:", e);
    return NextResponse.json({ error: `Regime: ${msg}` }, { status: 500 });
  }
}
