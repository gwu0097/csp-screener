// Helpers for the per-quarter crush history surfaced on the screener
// expanded row. Reads earnings_history rows for a symbol, derives a
// per-event ratio + grade, and labels each row by calendar quarter.

import { createServerClient } from "@/lib/supabase";

export type CrushHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  impliedMovePct: number | null;
  actualMovePct: number | null;
  ratio: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  impliedMoveSource: string | null;
};

// Quarter label from earnings date. Companies typically report a
// fiscal quarter ~1 month after it ends, so:
//   Jan-Mar → prior year Q4
//   Apr-Jun → current year Q1
//   Jul-Sep → current year Q2
//   Oct-Dec → current year Q3
export function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

// Per-event grade from ratio (matches the global crush bands the user
// described — A < 0.7, B < 0.85, C < 1.0, D < 1.2, F otherwise).
export function gradeFromRatio(ratio: number | null): CrushHistoryEvent["grade"] {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.7) return "A";
  if (ratio < 0.85) return "B";
  if (ratio < 1.0) return "C";
  if (ratio < 1.2) return "D";
  return "F";
}

// Pulls the last `limit` earnings_history rows for a symbol with the
// fields the crush table needs. Caller can run this in parallel with
// other stage-3 work.
export async function getCrushHistory(
  symbol: string,
  limit = 8,
): Promise<CrushHistoryEvent[]> {
  const sb = createServerClient();
  const res = await sb
    .from("earnings_history")
    .select(
      "earnings_date,implied_move_pct,actual_move_pct,move_ratio,implied_move_source",
    )
    .eq("symbol", symbol.toUpperCase())
    .order("earnings_date", { ascending: false })
    .limit(limit);
  if (res.error) {
    console.warn(
      `[earnings-history-table] ${symbol} fetch failed: ${res.error.message}`,
    );
    return [];
  }
  type Row = {
    earnings_date: string;
    implied_move_pct: number | null;
    actual_move_pct: number | null;
    move_ratio: number | null;
    implied_move_source: string | null;
  };
  const rows = (res.data ?? []) as Row[];
  return rows.map((r) => {
    const ratio =
      r.move_ratio ??
      (r.actual_move_pct !== null &&
      r.implied_move_pct !== null &&
      r.implied_move_pct > 0
        ? Math.abs(r.actual_move_pct) / r.implied_move_pct
        : null);
    return {
      earningsDate: r.earnings_date,
      qtrLabel: quarterLabel(r.earnings_date),
      impliedMovePct: r.implied_move_pct,
      actualMovePct: r.actual_move_pct,
      ratio,
      grade: gradeFromRatio(ratio),
      impliedMoveSource: r.implied_move_source,
    };
  });
}

// Persists the live IV-implied move for a candidate's upcoming earnings
// event. Called from the screener when stage 3 computes emPct so we
// build a real per-event EM history over time. Only writes the two
// fields — other earnings_history columns stay untouched on update.
export async function persistLiveImpliedMove(
  symbol: string,
  earningsDate: string,
  emPct: number | null,
  source: "schwab" | "perplexity" = "schwab",
): Promise<void> {
  if (emPct === null || !Number.isFinite(emPct) || emPct <= 0) return;
  const sb = createServerClient();
  const upsert = await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        earnings_date: earningsDate,
        implied_move_pct: emPct,
        implied_move_source: source,
      },
      { onConflict: "symbol,earnings_date" },
    );
  if (upsert.error) {
    console.warn(
      `[earnings-history-table] persist live EM ${symbol}@${earningsDate} failed: ${upsert.error.message}`,
    );
  }
}
