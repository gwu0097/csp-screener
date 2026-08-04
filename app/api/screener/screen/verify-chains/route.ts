import { NextRequest, NextResponse } from "next/server";
import { isSchwabConnected, getOptionsChain } from "@/lib/schwab";
import { buildCandidateFromEarnings, chainHasWeeklyExpiry } from "@/lib/screener";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stream C of the Screen Today pipeline — binary weekly-chain
// verification, batched by the client. Per-row cost is one or two
// Schwab options-chain fetches (retry below), all in a batch run in
// parallel via Promise.all.
//
// The full screen flow is:
//   POST /api/screener/screen          → calendar + filters + Stage 2
//                                         quality floor (Yahoo + Finnhub
//                                         only, no Schwab) + prices
//   POST /api/screener/screen/verify-chains → chain verification
//                                              (this route)
//   POST /api/screener/analyze/pass2 + /pass3* → all scoring (Stage
//                                              1 crush, Stage 3+4
//                                              options math, Pass 3
//                                              Perplexity, three-layer)
//
// Every outcome is persisted to chain_verification_log, per symbol
// per run (runId groups every batch from one Screen Today click) —
// this used to be entirely unlogged. A symbol that genuinely has no
// weekly chain and a symbol that failed to fetch for an unrelated
// reason looked identical from the outside (both just vanished from
// the candidate list) — confirmed on a live audit where AMD and DIS,
// which both had real weekly chains, were dropped here with zero
// trace and were indistinguishable from "no weekly options" without
// manually re-deriving the whole pipeline after the fact.
//
// Each candidate gets up to MAX_ATTEMPTS tries before a non-"verified"
// result is finalized — the failure mode this exists for (a chain
// fetch that comes back empty or errors for a symbol that genuinely
// has a weekly chain) is demonstrably intermittent: the same AMD/DIS
// audit reproduced a clean "verified" from identical code minutes
// later. A retry recovers those automatically instead of only
// logging the loss.
export const maxDuration = 60;

type VerifyStatus = "verified" | "no_weekly_chain" | "fetch_failed";

type VerifyRow = {
  symbol: string;
  status: VerifyStatus;
  // Friday on/after earnings_date that the chain was checked
  // against. Returned for telemetry / debugging.
  expiry?: string;
  // Populated for fetch_failed (the raw error) — absent for the
  // other two statuses, which don't need one.
  reason?: string;
};

type Body = {
  // Groups every batch from one Screen Today click in
  // chain_verification_log. Client-generated (crypto.randomUUID());
  // optional so a caller that doesn't send one just gets a null-runId
  // log row instead of a hard 400.
  runId?: unknown;
  candidates?: Array<{
    symbol?: unknown;
    date?: unknown; // earnings date (YYYY-MM-DD)
    timing?: unknown; // "BMO" | "AMC"
    price?: unknown;
  }>;
};

const MAX_BATCH = 25;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One attempt: fetch the chain pinned to the exact target expiry.
// Schwab answering with a non-empty response that just doesn't
// contain that date is a reliable "no weekly options here" signal
// (confirmed live: names with only monthly cycles — AFG, CDW, ZBH —
// reproducibly return empty maps for a pinned off-cycle date while
// still returning their real monthly expiries for an unpinned query)
// — that's `no_weekly_chain`, not a failure. Only a thrown
// error/unreachable Schwab is `fetch_failed`.
async function attemptChainCheck(
  symbol: string,
  expiry: string,
): Promise<{ status: VerifyStatus; errorDetail: string | null }> {
  try {
    const chain = await getOptionsChain(symbol, expiry, "PUT", 30);
    const looksValid =
      (!!chain.putExpDateMap && Object.keys(chain.putExpDateMap).length > 0) ||
      (!!chain.callExpDateMap && Object.keys(chain.callExpDateMap).length > 0);
    if (looksValid && chainHasWeeklyExpiry(chain, expiry)) {
      return { status: "verified", errorDetail: null };
    }
    return { status: "no_weekly_chain", errorDetail: null };
  } catch (e) {
    return { status: "fetch_failed", errorDetail: e instanceof Error ? e.message : String(e) };
  }
}

type LogRow = {
  user_id: string;
  run_id: string | null;
  symbol: string;
  earnings_date: string | null;
  expiry: string | null;
  status: VerifyStatus;
  error_detail: string | null;
  attempts: number;
};

async function persistLog(rows: LogRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const sb = createServerClient();
    const res = await sb.from("chain_verification_log").insert(rows);
    if (res.error) {
      console.warn(`[verify-chains] persist failed: ${res.error.message}`);
    }
  } catch (e) {
    console.warn(`[verify-chains] persist threw: ${e instanceof Error ? e.message : e}`);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const t0 = Date.now();
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : null;
  const candidates = (body.candidates ?? []).slice(0, MAX_BATCH);
  if (candidates.length === 0) {
    return NextResponse.json({ verifications: [] });
  }

  const { connected } = await isSchwabConnected().catch(() => ({
    connected: false,
  }));

  // Schwab disconnected → mark the entire batch fetch_failed up-front
  // and skip the network round-trips. The client keeps these rows
  // visible now instead of dropping them.
  if (!connected) {
    const logRows: LogRow[] = [];
    const verifications: VerifyRow[] = candidates.map((c) => {
      const symbol = String(c.symbol ?? "").toUpperCase();
      logRows.push({
        user_id: userId,
        run_id: runId,
        symbol,
        earnings_date: typeof c.date === "string" ? c.date : null,
        expiry: null,
        status: "fetch_failed",
        error_detail: "schwab_disconnected",
        attempts: 1,
      });
      return { symbol, status: "fetch_failed", reason: "schwab_disconnected" };
    });
    console.log(
      `[verify-chains] Schwab not connected — ${candidates.length} marked fetch_failed`,
    );
    await persistLog(logRows);
    return NextResponse.json({ verifications });
  }

  const logRows: LogRow[] = [];

  // Verify each candidate's chain in parallel. Per-row failures
  // don't fail the whole batch — a Schwab hiccup on one symbol just
  // makes that one fetch_failed.
  const verifications = await Promise.all(
    candidates.map(async (c): Promise<VerifyRow> => {
      const symbol = String(c.symbol ?? "").toUpperCase();
      const date = typeof c.date === "string" ? c.date : "";
      const timing =
        c.timing === "BMO" || c.timing === "AMC" ? c.timing : "AMC";
      const price = typeof c.price === "number" ? c.price : 0;
      if (!symbol || !date) {
        logRows.push({
          user_id: userId,
          run_id: runId,
          symbol,
          earnings_date: date || null,
          expiry: null,
          status: "fetch_failed",
          error_detail: "missing_fields",
          attempts: 1,
        });
        return { symbol, status: "fetch_failed", reason: "missing_fields" };
      }
      const candidate = buildCandidateFromEarnings(
        { symbol, date, timing },
        price,
      );

      let attempts = 0;
      let last: { status: VerifyStatus; errorDetail: string | null } = {
        status: "fetch_failed",
        errorDetail: "unattempted",
      };
      for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
        last = await attemptChainCheck(symbol, candidate.expiry);
        if (last.status === "verified") break;
        if (attempts < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }

      logRows.push({
        user_id: userId,
        run_id: runId,
        symbol,
        earnings_date: date,
        expiry: candidate.expiry,
        status: last.status,
        error_detail: last.errorDetail,
        attempts,
      });

      return {
        symbol,
        status: last.status,
        expiry: candidate.expiry,
        reason: last.errorDetail ?? undefined,
      };
    }),
  );

  const verified = verifications.filter((v) => v.status === "verified").length;
  const noWeeklyChain = verifications.filter((v) => v.status === "no_weekly_chain").length;
  const fetchFailed = verifications.filter((v) => v.status === "fetch_failed").length;
  console.log(
    `[verify-chains] batch=${candidates.length} verified=${verified} no_weekly_chain=${noWeeklyChain} fetch_failed=${fetchFailed} · ${Date.now() - t0}ms`,
  );

  await persistLog(logRows);
  return NextResponse.json({ verifications });
}
