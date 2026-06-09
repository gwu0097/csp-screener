import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { refreshSymbolSnapshot } from "@/lib/market-snapshot";
import { getHistoricalPrices } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// Batch force-refresh. POST { symbols?: string[], force?: boolean }.
// With no symbols, refreshes everything currently in the snapshot table.
// `force` means refreshSymbolSnapshot() directly (bypasses the 15-min
// TTL) — the global dashboard Refresh button uses this.
//
// Vercel Hobby has a 60s ceiling and each refresh hits Yahoo 3× (quote +
// 90d + 3Y). To stay safe with ~33 symbols we run ≤15 in one pooled
// pass, and split larger sets into two SEQUENTIAL pooled halves to avoid
// a single big burst against Yahoo.

const DAY_MS = 86400000;
const MAX_CONCURRENT = 10;
const SPLIT_THRESHOLD = 15;

// SPY 3Y benchmark fetched ONCE and passed into every refresh so we don't
// re-pull SPY per symbol.
async function spyThreeYearReturn(): Promise<number | null> {
  const to = new Date();
  const from = new Date(Date.now() - 3 * 365 * DAY_MS - 7 * DAY_MS);
  const bars = await getHistoricalPrices("SPY", from, to).catch(() => []);
  const sorted = [...bars]
    .filter((b) => b.close > 0 && b.date)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (sorted.length < 2 || sorted[0].close <= 0) return null;
  const first = sorted[0].close;
  const last = sorted[sorted.length - 1].close;
  return ((last - first) / first) * 100;
}

async function runPool(
  items: string[],
  limit: number,
  fn: (s: string) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { symbols?: unknown; force?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine — refresh everything */
  }

  let symbols: string[];
  if (Array.isArray(body.symbols) && body.symbols.length > 0) {
    symbols = body.symbols.map((s) => String(s).toUpperCase());
  } else {
    const sb = createServerClient();
    const r = await sb.from("symbol_market_snapshot").select("symbol");
    symbols = ((r.data ?? []) as Array<{ symbol: string }>).map((x) =>
      x.symbol.toUpperCase(),
    );
  }
  symbols = Array.from(new Set(symbols)).filter(Boolean);
  if (symbols.length === 0) {
    return NextResponse.json({ refreshed: 0, errors: [], duration_ms: Date.now() - t0 });
  }

  const spy3y = await spyThreeYearReturn();
  const errors: string[] = [];
  let refreshed = 0;
  const doOne = async (sym: string) => {
    try {
      const snap = await refreshSymbolSnapshot(sym, { spy3yReturn: spy3y });
      if (snap) refreshed += 1;
      else errors.push(`${sym}: Yahoo unavailable`);
    } catch (e) {
      errors.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (symbols.length <= SPLIT_THRESHOLD) {
    await runPool(symbols, MAX_CONCURRENT, doOne);
  } else {
    // Two sequential pooled halves to avoid one large Yahoo burst.
    const mid = Math.ceil(symbols.length / 2);
    await runPool(symbols.slice(0, mid), MAX_CONCURRENT, doOne);
    await runPool(symbols.slice(mid), MAX_CONCURRENT, doOne);
  }

  return NextResponse.json({
    refreshed,
    errors,
    duration_ms: Date.now() - t0,
  });
}
