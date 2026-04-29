import { NextRequest, NextResponse } from "next/server";
import { isSchwabConnected } from "@/lib/schwab";
import {
  buildCandidateFromEarnings,
  chainHasWeeklyExpiry,
  safeGetChain,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stream C of the Screen Today pipeline — Schwab weekly-chain
// verification, batched by the client. Stays well under the Vercel
// 60s ceiling at batch size 10 (each Schwab call ~1-2s, all 10 run
// in parallel via Promise.all). The full screen flow is now:
//   POST /api/screener/screen          → Stream A (calendar + filters
//                                         + prices + Stage 1+2 scoring)
//   POST /api/screener/screen/verify-chains → Stream C (chain check,
//                                              this route, batched)
// The client orchestrates both, retries failed batches once, and
// stamps chainUnverified=true on rows that couldn't be verified —
// the screen never goes empty just because Schwab is having a bad
// day.
export const maxDuration = 60;

type VerifyStatus = "present" | "absent" | "unverified";

type VerifyRow = {
  symbol: string;
  status: VerifyStatus;
  // The expiry the chain was checked against (the Friday on/after
  // earnings_date). Returned for telemetry / debugging.
  expiry?: string;
  // True only when status === "absent" — Schwab returned a valid
  // chain but no weekly Friday expiry was present. Useful for the
  // client to drop verified-absent rows when the symbol isn't
  // whitelisted.
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

  // When Schwab is disconnected, mark the entire batch as unverified
  // up-front and skip the network round-trips. The client will pass
  // these rows through with chainUnverified=true.
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

  // Verify each candidate's chain in parallel. Per-row failures don't
  // fail the whole batch — a Schwab hiccup on one symbol just makes
  // that one unverified.
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
