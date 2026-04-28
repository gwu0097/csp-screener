import { NextRequest, NextResponse } from "next/server";
import { getEarningsNewsContext } from "@/lib/perplexity";
import type { ScreenerResult } from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Pass 3a — Perplexity news-context fetch only. Splits the slow news
// half of pass3 out so the client can drive parallel/pipelined batches
// (one batch in this route while another batch is grading in pass3b).
// All Perplexity calls inside a batch run in parallel via Promise.all,
// so wall-clock time is bounded by the slowest call rather than the
// sum.
export const maxDuration = 60;

type Body = {
  candidates?: unknown;
};

// Stable key used by the client to merge news back into the candidate
// list. Same shape used elsewhere in screener-view.tsx.
function keyOf(symbol: string, earningsDate: string): string {
  return `${symbol}|${earningsDate}`;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "Missing candidates array" },
      { status: 400 },
    );
  }
  const candidates = body.candidates as ScreenerResult[];
  if (candidates.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const t0 = Date.now();
  const results = await Promise.all(
    candidates.map(async (c) => {
      const news = await getEarningsNewsContext(c.symbol, c.symbol).catch(
        () => ({
          summary: "News fetch failed",
          sentiment: "neutral" as const,
          hasActiveOverhang: false,
          overhangDescription: null,
          sources: [],
          gradePenalty: 0,
        }),
      );
      return {
        key: keyOf(c.symbol, c.earningsDate),
        symbol: c.symbol,
        earningsDate: c.earningsDate,
        news,
      };
    }),
  );
  const elapsed = Date.now() - t0;
  console.log(
    `[analyze/pass3a] ${candidates.length} candidates · ${elapsed}ms · symbols=[${candidates
      .map((c) => c.symbol)
      .slice(0, 8)
      .join(",")}${candidates.length > 8 ? ",…" : ""}]`,
  );
  return NextResponse.json({ results, elapsedMs: elapsed });
}
