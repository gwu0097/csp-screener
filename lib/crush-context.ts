// Pure helpers for the per-symbol "Trade Decision Context" Perplexity
// pull. Lives in /lib so the route handler stays thin and tests can
// exercise the prompt + parser without making network calls.

export type OutlierQuarter = {
  date: string;
  qtrLabel?: string;
  actualMove: number; // signed fraction, e.g. -0.1155
  direction: "up" | "down";
  ratio: number; // |actual| / implied
  impliedMove: number; // fraction
};

export type OutlierAnalysis = {
  quarter: string;
  date: string;
  cause: string;
  similar_today: boolean;
  similarity_explanation: string;
};

export type CrushContext = {
  outlier_analyses: OutlierAnalysis[];
  overall_risk: "high" | "medium" | "low";
  key_metric_to_watch: string;
  current_setup_resembles: "outlier" | "normal";
  verdict: string;
  safe_to_trade: boolean;
  confidence: "high" | "medium" | "low";
};

const VALID_RISK = new Set(["high", "medium", "low"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_RESEMBLES = new Set(["outlier", "normal"]);

export function buildCrushContextPrompt(args: {
  symbol: string;
  companyName: string;
  outlierQuarters: OutlierQuarter[];
}): string {
  const { symbol, companyName, outlierQuarters } = args;
  const heading = companyName ? `${symbol} (${companyName})` : symbol;
  // Ratio displayed as 1.31x; moves shown as +/- whole-number percent.
  const lines = outlierQuarters
    .map(
      (q) =>
        `${q.qtrLabel ?? q.date}: stock moved ${(q.actualMove * 100).toFixed(2)}% (${q.ratio.toFixed(2)}x the implied move of ${(q.impliedMove * 100).toFixed(2)}%)`,
    )
    .join("\n");
  return `You are helping a trader decide whether to sell a cash-secured put on ${heading} ahead of earnings tomorrow.

Historical analysis shows ${symbol} had ${outlierQuarters.length} quarter(s) where the stock moved significantly beyond the options-implied range:

${lines}

For each outlier quarter above:
1. What SPECIFICALLY caused the stock to move beyond the implied range that quarter? (guidance cut, metric miss, one-time item, macro shock, etc.)
2. Is that same condition present TODAY heading into tomorrow's earnings?

Then give an overall verdict:
- Is the risk of another outsized move HIGH, MEDIUM, or LOW based on current conditions?
- What is the ONE metric or factor to watch most closely in tomorrow's print?
- Does the current setup look more like the outlier quarter(s) or the normal quarters?

Return ONLY this JSON:
{
  "outlier_analyses": [
    {
      "quarter": "Q2 2025",
      "date": "2025-07-29",
      "cause": "2-3 specific sentences on what caused the outsized move",
      "similar_today": true,
      "similarity_explanation": "1-2 sentences comparing conditions then vs now"
    }
  ],
  "overall_risk": "high",
  "key_metric_to_watch": "specific metric or factor most important for this print",
  "current_setup_resembles": "outlier",
  "verdict": "2-3 sentences summarizing whether conditions match the outlier(s) and whether it is safe to trade",
  "safe_to_trade": true,
  "confidence": "high"
}`;
}

// Same JSON-extraction cascade we use elsewhere (research-modules,
// catalyst-scanner). Direct → fenced → outermost {…}.
function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const d = JSON.parse(trimmed);
    if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      const d = JSON.parse(fenced[1].trim());
      if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const d = JSON.parse(m[0]);
      if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>;
    } catch {
      /* swallow */
    }
  }
  return null;
}

function toStr(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
}

// Parses Perplexity's response into the typed CrushContext, defaulting
// any missing fields rather than throwing — better to surface a partial
// result with sensible defaults than make the UI fail open.
export function parseCrushContext(rawText: string): CrushContext | null {
  const parsed = tryParseObject(rawText);
  if (!parsed) return null;

  const analysesRaw = Array.isArray(parsed.outlier_analyses)
    ? (parsed.outlier_analyses as unknown[])
    : [];
  const outlier_analyses: OutlierAnalysis[] = analysesRaw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const cause = toStr(o.cause);
    if (!cause) return [];
    return [
      {
        quarter: toStr(o.quarter, toStr(o.date, "—")),
        date: toStr(o.date),
        cause,
        similar_today:
          typeof o.similar_today === "boolean" ? o.similar_today : false,
        similarity_explanation: toStr(o.similarity_explanation),
      },
    ];
  });

  const riskRaw = toStr(parsed.overall_risk).toLowerCase();
  const overall_risk = (VALID_RISK.has(riskRaw) ? riskRaw : "medium") as
    | "high"
    | "medium"
    | "low";

  const confidenceRaw = toStr(parsed.confidence).toLowerCase();
  const confidence = (VALID_CONFIDENCE.has(confidenceRaw)
    ? confidenceRaw
    : "low") as "high" | "medium" | "low";

  const resemblesRaw = toStr(parsed.current_setup_resembles).toLowerCase();
  const current_setup_resembles = (VALID_RESEMBLES.has(resemblesRaw)
    ? resemblesRaw
    : "outlier") as "outlier" | "normal";

  return {
    outlier_analyses,
    overall_risk,
    key_metric_to_watch: toStr(parsed.key_metric_to_watch, "—"),
    current_setup_resembles,
    verdict: toStr(parsed.verdict, "(no verdict returned)"),
    safe_to_trade:
      typeof parsed.safe_to_trade === "boolean" ? parsed.safe_to_trade : false,
    confidence,
  };
}
