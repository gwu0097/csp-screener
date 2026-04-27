import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  gradeFromRatio,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Per-quarter CSP history feed for the /research/[symbol] CSP tab.
// Joins earnings_history (one row per past or upcoming event) with the
// per-event screener_crush_context cache (set on outlier-quarter
// research) and returns a single timeline ordered newest-first.
//
// Both flow_* columns and screener_crush_context.earnings_date come
// from migration 009. If the migration hasn't been applied yet, the
// queries gracefully degrade — flow fields render as null and the
// trade-decision section shows "no context recorded for this quarter".

type FlowUnusualEntry = {
  type?: string;
  strike?: number;
  volume?: number;
  oi?: number;
  ratio?: number;
  note?: string;
};

type CspHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  impliedMove: number | null;
  actualMove: number | null;
  direction: "up" | "down" | null;
  crushRatio: number | null;
  crushGrade: CrushHistoryEvent["grade"];
  flowPcRatio: number | null;
  flowBias: string | null;
  flowDeepOtmPct: number | null;
  flowUnusualTop3: FlowUnusualEntry[] | null;
  flowCapturedAt: string | null;
  tradeContext: {
    overallRisk: string;
    verdict: string;
    safeToTrade: boolean;
    outlierAnalyses: unknown[];
    keyMetricToWatch: string;
    confidence: string;
    currentSetupResembles: string;
  } | null;
};

type EarningsHistoryRow = {
  earnings_date: string;
  implied_move_pct: number | null;
  actual_move_pct: number | null;
  move_ratio: number | null;
  flow_pc_ratio?: number | string | null;
  flow_bias?: string | null;
  flow_deep_otm_put_pct?: number | string | null;
  flow_unusual_top3?: unknown;
  flow_captured_at?: string | null;
};

type CrushContextPayload = {
  outlier_analyses?: unknown;
  overall_risk?: unknown;
  key_metric_to_watch?: unknown;
  current_setup_resembles?: unknown;
  verdict?: unknown;
  safe_to_trade?: unknown;
  confidence?: unknown;
};

function quarterLabel(dateIso: string): string {
  // Same convention as lib/earnings-history-table.quarterLabel — kept
  // local so the route doesn't pull a UI helper.
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function normaliseUnusual(v: unknown): FlowUnusualEntry[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: FlowUnusualEntry[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    out.push({
      type: typeof o.type === "string" ? o.type : undefined,
      strike: toNum(o.strike) ?? undefined,
      volume: toNum(o.volume) ?? undefined,
      oi: toNum(o.oi) ?? undefined,
      ratio: toNum(o.ratio) ?? undefined,
      note: typeof o.note === "string" ? o.note : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const sb = createServerClient();
  // SELECT * so the route works whether or not migration 009 has been
  // applied — flow_* columns simply read as undefined pre-migration.
  const ehRes = await sb
    .from("earnings_history")
    .select("*")
    .eq("symbol", symbol)
    .order("earnings_date", { ascending: false });
  if (ehRes.error) {
    return NextResponse.json(
      { error: ehRes.error.message },
      { status: 500 },
    );
  }
  const rows = (ehRes.data ?? []) as EarningsHistoryRow[];
  if (rows.length === 0) {
    return NextResponse.json({ events: [] });
  }

  // Crush context per (symbol, earnings_date) — best-effort. Migration
  // 009 added the earnings_date keying; if it hasn't run the .in()
  // filter errors out and we just render no context.
  const dates = rows.map((r) => r.earnings_date).filter(Boolean);
  const contextByDate = new Map<string, CrushContextPayload>();
  if (dates.length > 0) {
    const ccRes = await sb
      .from("screener_crush_context")
      .select("earnings_date,context")
      .eq("symbol", symbol)
      .in("earnings_date", dates);
    if (!ccRes.error) {
      const ccRows = (ccRes.data ?? []) as Array<{
        earnings_date: string;
        context: CrushContextPayload | null;
      }>;
      for (const row of ccRows) {
        if (row.earnings_date && row.context) {
          contextByDate.set(row.earnings_date, row.context);
        }
      }
    } else {
      console.warn(
        `[csp-history] ${symbol} crush-context lookup failed (migration 009 applied?): ${ccRes.error.message}`,
      );
    }
  }

  const events: CspHistoryEvent[] = rows.map((r) => {
    const implied = toNum(r.implied_move_pct);
    const actual = toNum(r.actual_move_pct);
    const ratio =
      toNum(r.move_ratio) ??
      (actual !== null && implied !== null && implied > 0
        ? Math.abs(actual) / implied
        : null);
    const ctx = contextByDate.get(r.earnings_date) ?? null;
    return {
      earningsDate: r.earnings_date,
      qtrLabel: quarterLabel(r.earnings_date),
      impliedMove: implied,
      actualMove: actual,
      direction: actual === null ? null : actual >= 0 ? "up" : "down",
      crushRatio: ratio,
      crushGrade: gradeFromRatio(ratio),
      flowPcRatio: toNum(r.flow_pc_ratio),
      flowBias: typeof r.flow_bias === "string" ? r.flow_bias : null,
      flowDeepOtmPct: toNum(r.flow_deep_otm_put_pct),
      flowUnusualTop3: normaliseUnusual(r.flow_unusual_top3),
      flowCapturedAt:
        typeof r.flow_captured_at === "string" ? r.flow_captured_at : null,
      tradeContext: ctx
        ? {
            overallRisk: toStr(ctx.overall_risk, "—"),
            verdict: toStr(ctx.verdict, "—"),
            safeToTrade:
              typeof ctx.safe_to_trade === "boolean" ? ctx.safe_to_trade : false,
            outlierAnalyses: Array.isArray(ctx.outlier_analyses)
              ? (ctx.outlier_analyses as unknown[])
              : [],
            keyMetricToWatch: toStr(ctx.key_metric_to_watch, "—"),
            confidence: toStr(ctx.confidence, "low"),
            currentSetupResembles: toStr(
              ctx.current_setup_resembles,
              "outlier",
            ),
          }
        : null,
    };
  });

  return NextResponse.json({ events });
}
