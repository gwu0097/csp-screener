// One-event-at-a-time Perplexity backfill for earnings_history rows
// missing implied_move_pct. Probe verified that Perplexity reliably
// returns specific numbers (with high/medium confidence) about half
// the time and self-reports null cleanly otherwise — see
// test/probe-historical-em. We accept only confidence ∈ {high, medium}
// AND the parsed value in the [5%, 25%] plausible range.
//
// Designed for Hobby's 60s ceiling: caller passes a `maxBackfills`
// budget. The route runs as many as it can inside its own timeout
// and reports counts; the user can re-trigger to keep going.

import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";

export type BackfillResult = {
  scanned: number;
  updated: number;
  skippedNoData: number;
  skippedLowConfidence: number;
  skippedImplausible: number;
  errors: string[];
  // Earliest row scanned and last row's date so the user can see
  // progress when re-triggering against a long backlog.
  firstSymbol: string | null;
  lastSymbol: string | null;
};

type Confidence = "high" | "medium" | "low" | "none";

function tryParse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const d = JSON.parse(trimmed);
    if (d && typeof d === "object" && !Array.isArray(d)) {
      return d as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      const d = JSON.parse(fenced[1].trim());
      if (d && typeof d === "object" && !Array.isArray(d)) {
        return d as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const d = JSON.parse(m[0]);
      if (d && typeof d === "object" && !Array.isArray(d)) {
        return d as Record<string, unknown>;
      }
    } catch {
      /* swallow */
    }
  }
  return null;
}

function buildPrompt(symbol: string, date: string): string {
  return `What was ${symbol} stock's options implied move percentage heading into their earnings on ${date}? I need the specific percentage that options were pricing in for the earnings move — this is typically shown as the straddle price divided by stock price, or referenced in financial media as 'options implied X% move'.

Return ONLY a JSON object, no markdown:
{
  "implied_move_pct": number or null,
  "confidence": "high"|"medium"|"low"|"none",
  "source_context": "brief explanation of where this number comes from"
}`;
}

export async function backfillImpliedMoves(opts: {
  maxBackfills: number;
  startTimeMs: number;
  // Bail when the route is within `safetyMs` of the Hobby ceiling so
  // the response can land cleanly. Default 50000ms = 10s buffer.
  safetyMs?: number;
}): Promise<BackfillResult> {
  const safety = opts.safetyMs ?? 50_000;
  const result: BackfillResult = {
    scanned: 0,
    updated: 0,
    skippedNoData: 0,
    skippedLowConfidence: 0,
    skippedImplausible: 0,
    errors: [],
    firstSymbol: null,
    lastSymbol: null,
  };

  const sb = createServerClient();
  // is.null filter via PostgREST: implied_move_pct=is.null. Limit to
  // the budget — older events first so we backfill chronologically.
  const queryRes = await sb
    .from("earnings_history")
    .select("symbol,earnings_date")
    .is("implied_move_pct", null)
    .order("earnings_date", { ascending: false })
    .limit(opts.maxBackfills);
  if (queryRes.error) {
    result.errors.push(`fetch null rows: ${queryRes.error.message}`);
    return result;
  }
  const rows = (queryRes.data ?? []) as Array<{
    symbol: string;
    earnings_date: string;
  }>;
  if (rows.length === 0) return result;
  result.firstSymbol = rows[0].symbol;
  result.lastSymbol = rows[rows.length - 1].symbol;

  for (const row of rows) {
    if (Date.now() - opts.startTimeMs > safety) {
      result.errors.push(
        `aborted at ${result.scanned}/${rows.length} — approaching 60s ceiling`,
      );
      break;
    }
    result.scanned += 1;
    const sym = row.symbol.toUpperCase();
    try {
      const raw = await askPerplexityRaw(buildPrompt(sym, row.earnings_date), {
        label: `backfill-em:${sym}:${row.earnings_date}`,
        maxTokens: 400,
      });
      if (!raw?.text) {
        result.skippedNoData += 1;
        continue;
      }
      const parsed = tryParse(raw.text);
      if (!parsed) {
        result.skippedNoData += 1;
        continue;
      }
      const v = parsed.implied_move_pct;
      const confRaw = parsed.confidence;
      const confidence: Confidence =
        confRaw === "high" || confRaw === "medium" || confRaw === "low" || confRaw === "none"
          ? confRaw
          : "none";
      if (typeof v !== "number" || !Number.isFinite(v)) {
        result.skippedNoData += 1;
        continue;
      }
      // Accept fraction (0.082) or whole-number percent (8.2). Store
      // as a fraction so it lines up with Schwab's emPct on the same
      // column (both are decimals like 0.082 = 8.2%).
      const pctWhole = Math.abs(v) <= 1 ? v * 100 : v;
      const fraction = pctWhole / 100;
      if (confidence !== "high" && confidence !== "medium") {
        result.skippedLowConfidence += 1;
        continue;
      }
      if (pctWhole < 5 || pctWhole > 25) {
        result.skippedImplausible += 1;
        continue;
      }
      const upd = await sb
        .from("earnings_history")
        .update({
          implied_move_pct: fraction,
          implied_move_source: "perplexity",
        })
        .eq("symbol", sym)
        .eq("earnings_date", row.earnings_date);
      if (upd.error) {
        result.errors.push(`${sym}@${row.earnings_date}: ${upd.error.message}`);
        continue;
      }
      result.updated += 1;
    } catch (e) {
      result.errors.push(
        `${sym}@${row.earnings_date}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Rate limit per spec.
    await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}
