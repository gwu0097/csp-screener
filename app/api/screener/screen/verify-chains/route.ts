import { NextRequest, NextResponse } from "next/server";
import { isSchwabConnected } from "@/lib/schwab";
import {
  buildCandidateFromEarnings,
  chainHasWeeklyExpiry,
  safeGetChain,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stream C of the Screen Today pipeline — binary weekly-chain
// verification, batched by the client. Per-row cost is just one
// Schwab options-chain fetch (~1-2s with a healthy token), all 10
// in a batch run in parallel via Promise.all.
//
// The full screen flow is:
//   POST /api/screener/screen          → calendar + filters + Stage 2
//                                         quality floor (Yahoo + Finnhub
//                                         only, no Schwab) + prices
//   POST /api/screener/screen/verify-chains → chain present/absent
//                                              (this route)
//   POST /api/screener/analyze/pass2 + /pass3* → all scoring (Stage
//                                              1 crush, Stage 3+4
//                                              options math, Pass 3
//                                              Perplexity, three-layer)
//
// The client orchestrates Stream A + Stream C, retries failed
// batches once, drops "absent" rows (no weekly Friday) unless
// whitelisted, and drops "unverified" rows entirely (Schwab
// unavailable) — surfacing the unverified count below the table
// instead of mixing them into the result list.
export const maxDuration = 60;

type VerifyStatus = "present" | "absent" | "unverified";

type VerifyRow = {
  symbol: string;
  status: VerifyStatus;
  // Friday on/after earnings_date that the chain was checked
  // against. Returned for telemetry / debugging.
  expiry?: string;
  reason?: string;
};

type Body = {
  candidates?: Array<{
    symbol?: unknown;
    date?: unknown; // earnings date (YYYY-MM-DD)
    timing?: unknown; // "BMO" | "AMC"
    price?: unknown;
  }>;
};

const MAX_BATCH = 25;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const t0 = Date.now();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const candidates = (body.candidates ?? []).slice(0, MAX_BATCH);
  if (candidates.length === 0) {
    return NextResponse.json({ verifications: [] });
  }

  const { connected } = await isSchwabConnected().catch(() => ({
    connected: false,
  }));

  // Schwab disconnected → mark the entire batch unverified up-front
  // and skip the network round-trips. The client drops these rows.
  if (!connected) {
    const verifications: VerifyRow[] = candidates.map((c) => ({
      symbol: String(c.symbol ?? "").toUpperCase(),
      status: "unverified",
      reason: "schwab_disconnected",
    }));
    console.log(
      `[verify-chains] Schwab not connected — ${candidates.length} marked unverified`,
    );
    return NextResponse.json({ verifications });
  }

  // Verify each candidate's chain in parallel. Per-row failures
  // don't fail the whole batch — a Schwab hiccup on one symbol just
  // makes that one unverified.
  const verifications = await Promise.all(
    candidates.map(async (c): Promise<VerifyRow> => {
      const symbol = String(c.symbol ?? "").toUpperCase();
      const date = typeof c.date === "string" ? c.date : "";
      const timing =
        c.timing === "BMO" || c.timing === "AMC" ? c.timing : "AMC";
      const price = typeof c.price === "number" ? c.price : 0;
      if (!symbol || !date) {
        return { symbol, status: "unverified", reason: "missing_fields" };
      }
      const candidate = buildCandidateFromEarnings(
        { symbol, date, timing },
        price,
      );
      try {
        const chain = await safeGetChain(
          symbol,
          candidate.expiry,
          candidate.expiry,
        );
        const reachable = chain !== null;
        const looksValid =
          reachable &&
          ((chain.putExpDateMap &&
            Object.keys(chain.putExpDateMap).length > 0) ||
            (chain.callExpDateMap &&
              Object.keys(chain.callExpDateMap).length > 0));
        if (looksValid && chainHasWeeklyExpiry(chain!, candidate.expiry)) {
          return { symbol, status: "present", expiry: candidate.expiry };
        }
        if (!reachable || !looksValid) {
          return {
            symbol,
            status: "unverified",
            expiry: candidate.expiry,
            reason: !reachable ? "schwab_error" : "empty_response",
          };
        }
        return {
          symbol,
          status: "absent",
          expiry: candidate.expiry,
          reason: "no_weekly_friday",
        };
      } catch (e) {
        return {
          symbol,
          status: "unverified",
          expiry: candidate.expiry,
          reason: e instanceof Error ? e.message : "throw",
        };
      }
    }),
  );

  const present = verifications.filter((v) => v.status === "present").length;
  const absent = verifications.filter((v) => v.status === "absent").length;
  const unverified = verifications.filter(
    (v) => v.status === "unverified",
  ).length;
  console.log(
    `[verify-chains] batch=${candidates.length} present=${present} absent=${absent} unverified=${unverified} · ${Date.now() - t0}ms`,
  );

  return NextResponse.json({ verifications });
}
