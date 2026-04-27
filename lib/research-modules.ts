// Research module persistence + cache logic. Each module type writes a
// new row to research_modules on every run (history preserved); the
// "latest" lookup returns the most recent non-expired row for that
// (symbol, type) pair. Cache TTL is per-module-type — fundamentals
// update quarterly, catalysts daily-ish, etc.

import { randomUUID } from "crypto";
import { createServerClient } from "@/lib/supabase";

export type ModuleType =
  | "business_overview"
  | "fundamental_health"
  | "catalyst_scanner"
  | "valuation_model"
  | "10k_deep_read"
  | "risk_assessment"
  | "sentiment"
  | "technical";

export const MODULE_EXPIRY_DAYS: Record<ModuleType, number | null> = {
  business_overview: 30,
  fundamental_health: 7,
  catalyst_scanner: 3,
  valuation_model: null, // historical — never expires
  "10k_deep_read": 90,
  risk_assessment: 14,
  sentiment: 3,
  technical: 7,
};

export type ResearchModule<T = unknown> = {
  id: string;
  symbol: string;
  moduleType: ModuleType;
  output: T;
  runAt: string;
  expiresAt: string | null;
  isExpired: boolean;
  isCustomized: boolean;
};

type DbRow = {
  id: string;
  symbol: string;
  module_type: string;
  output: unknown;
  is_customized: boolean | null;
  run_at: string;
  expires_at: string | null;
};

function rowToModule<T>(row: DbRow): ResearchModule<T> {
  const isExpired =
    row.expires_at !== null && new Date(row.expires_at).getTime() < Date.now();
  return {
    id: row.id,
    symbol: row.symbol,
    moduleType: row.module_type as ModuleType,
    output: row.output as T,
    runAt: row.run_at,
    expiresAt: row.expires_at,
    isExpired,
    isCustomized: !!row.is_customized,
  };
}

export async function getLatestModule<T = unknown>(
  symbol: string,
  moduleType: ModuleType,
): Promise<ResearchModule<T> | null> {
  const sb = createServerClient();
  const res = await sb
    .from("research_modules")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .eq("module_type", moduleType)
    .order("run_at", { ascending: false })
    .limit(1);
  if (res.error) {
    console.warn(
      `[research-modules] getLatest(${symbol}, ${moduleType}) failed: ${res.error.message}`,
    );
    return null;
  }
  const row = (res.data ?? [])[0] as DbRow | undefined;
  if (!row) return null;
  return rowToModule<T>(row);
}

export async function getModuleHistory<T = unknown>(
  symbol: string,
  moduleType: ModuleType,
): Promise<ResearchModule<T>[]> {
  const sb = createServerClient();
  const res = await sb
    .from("research_modules")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .eq("module_type", moduleType)
    .order("run_at", { ascending: false });
  if (res.error) {
    console.warn(
      `[research-modules] getHistory(${symbol}, ${moduleType}) failed: ${res.error.message}`,
    );
    return [];
  }
  return (res.data as DbRow[]).map((r) => rowToModule<T>(r));
}

export async function saveModule<T>(
  symbol: string,
  moduleType: ModuleType,
  output: T,
): Promise<ResearchModule<T>> {
  const sb = createServerClient();
  const upper = symbol.toUpperCase();
  const expiryDays = MODULE_EXPIRY_DAYS[moduleType];
  const expiresAt =
    expiryDays === null
      ? null
      : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  // Upsert the parent stock row first so we can grab its id — research_modules
  // has a NOT NULL stock_id FK in production. .select() flips the upsert's
  // Prefer header to include return=representation so PostgREST sends the row
  // back regardless of whether it was inserted or updated.
  const stockUp = await sb
    .from("research_stocks")
    .upsert(
      { symbol: upper, last_researched_at: new Date().toISOString() },
      { onConflict: "symbol" },
    )
    .select()
    .single();
  if (stockUp.error) {
    throw new Error(
      `[research-modules] research_stocks upsert(${symbol}) failed: ${stockUp.error.message}`,
    );
  }
  const stockId = (stockUp.data as { id?: string } | null)?.id ?? null;
  if (!stockId) {
    throw new Error(
      `[research-modules] research_stocks upsert(${symbol}) returned no id`,
    );
  }
  console.log(`[saveModule] stock_id: ${stockId} (${upper}, ${moduleType})`);

  const ins = await sb
    .from("research_modules")
    .insert({
      stock_id: stockId,
      symbol: upper,
      module_type: moduleType,
      output,
      run_at: new Date().toISOString(),
      expires_at: expiresAt,
    })
    .select()
    .single();
  if (ins.error) {
    throw new Error(
      `[research-modules] save(${symbol}, ${moduleType}) failed: ${ins.error.message}`,
    );
  }

  return rowToModule<T>(ins.data as DbRow);
}

// ---------- Overall grade ----------
//
// Five-input weighted score. Each present input contributes up to its
// max; absent inputs simply don't accrue points (so a stock with only
// fundamentals + catalysts run will mechanically score lower than one
// where all five have run, which is the intent — graded confidence
// scales with how much research has been done).
//
// Max points: fundamentals 30 / catalyst 20 / sentiment 20 / risk 20
// / valuation upside 10 = 100. Grade thresholds A≥80, B≥65, C≥45.

export type OverallGrade = "A" | "B" | "C" | "D" | null;

export type GradeInputs = {
  fundamentalHealthScore?: number | null; // 0-10
  catalystScore?: "rich" | "moderate" | "sparse" | null;
  sentimentScore?: number | null; // 0-10
  riskLevel?: "low" | "medium" | "high" | null;
  weightedReturn?: number | null; // valuation weighted return (e.g. 0.25 = +25%)
};

export function computeOverallGrade(
  inputs: GradeInputs,
): { grade: OverallGrade; reasoning: string } {
  const fh = inputs.fundamentalHealthScore;
  const cat = inputs.catalystScore;
  const sent = inputs.sentimentScore;
  const risk = inputs.riskLevel;
  const ret = inputs.weightedReturn;

  // Count distinct module groups that have contributed an input. We
  // only grade when at least two are present so a half-built profile
  // doesn't get an A by default.
  const present = [
    fh !== null && fh !== undefined,
    cat !== null && cat !== undefined,
    sent !== null && sent !== undefined,
    risk !== null && risk !== undefined,
    ret !== null && ret !== undefined,
  ].filter(Boolean).length;
  if (present < 2) {
    return {
      grade: null,
      reasoning:
        present === 0
          ? "Not yet graded."
          : "Run at least two modules to compute a grade.",
    };
  }

  let score = 0;
  const parts: string[] = [];

  if (fh !== null && fh !== undefined) {
    score += Math.max(0, Math.min(10, fh)) * 3;
    parts.push(`fundamentals ${fh}/10`);
  }
  if (cat) {
    score += cat === "rich" ? 20 : cat === "moderate" ? 10 : 0;
    parts.push(`${cat} catalysts`);
  }
  if (sent !== null && sent !== undefined) {
    score += Math.max(0, Math.min(10, sent)) * 2;
    parts.push(`sentiment ${sent}/10`);
  }
  if (risk) {
    score += risk === "low" ? 20 : risk === "medium" ? 10 : 0;
    parts.push(`${risk} risk`);
  }
  if (ret !== null && ret !== undefined) {
    if (ret > 0.5) score += 10;
    else if (ret > 0.25) score += 5;
    else if (ret > 0) score += 2;
    const pct = (ret * 100).toFixed(0);
    parts.push(`valuation ${ret >= 0 ? "+" : ""}${pct}%`);
  }

  const grade: OverallGrade =
    score >= 80 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : "D";

  // One-sentence reasoning, prepended with a qualitative leading clause
  // tied to the grade so the tooltip reads naturally.
  const lead =
    grade === "A"
      ? "Strong setup"
      : grade === "B"
        ? "Solid setup"
        : grade === "C"
          ? "Mixed signals"
          : "Weak setup";
  const reasoning = `${lead} — ${parts.join(", ")} (score ${score}/100).`;
  return { grade, reasoning };
}

export async function recomputeOverallGrade(symbol: string): Promise<void> {
  const sb = createServerClient();
  const upper = symbol.toUpperCase();
  const [fh, cs, sm, rk, vm] = await Promise.all([
    getLatestModule<{ healthScore?: number }>(upper, "fundamental_health"),
    getLatestModule<{ overall_catalyst_score?: "rich" | "moderate" | "sparse" }>(
      upper,
      "catalyst_scanner",
    ),
    getLatestModule<{ sentiment_score?: number }>(upper, "sentiment"),
    getLatestModule<{ overall_risk_level?: "low" | "medium" | "high" }>(
      upper,
      "risk_assessment",
    ),
    getLatestModule<unknown>(upper, "valuation_model"),
  ]);

  // Pull the weighted return from whichever valuation schema is on the
  // row — tier1 (v2), legacy (v1), or absent.
  let weightedReturn: number | null = null;
  const vmOut = vm?.output as Record<string, unknown> | undefined;
  if (vmOut) {
    if (vmOut.schema_version === 2) {
      const r = (vmOut.tier1 as { outputs?: { weighted_return_pct?: number } } | undefined)
        ?.outputs?.weighted_return_pct;
      weightedReturn = typeof r === "number" && Number.isFinite(r) ? r : null;
    } else {
      const r = (vmOut as { outputs?: { weighted_return_pct?: number } }).outputs
        ?.weighted_return_pct;
      weightedReturn = typeof r === "number" && Number.isFinite(r) ? r : null;
    }
  }

  const { grade, reasoning } = computeOverallGrade({
    fundamentalHealthScore: fh?.output?.healthScore ?? null,
    catalystScore: cs?.output?.overall_catalyst_score ?? null,
    sentimentScore: sm?.output?.sentiment_score ?? null,
    riskLevel: rk?.output?.overall_risk_level ?? null,
    weightedReturn,
  });
  const upd = await sb
    .from("research_stocks")
    .update({ overall_grade: grade, grade_reasoning: reasoning })
    .eq("symbol", upper);
  if (upd.error) {
    console.warn(
      `[research-modules] grade update(${symbol}) failed: ${upd.error.message}`,
    );
  }
}

// JSON-from-LLM extraction cascade. Same shape used elsewhere in the
// codebase (lib/swing-screener for catalyst pass) — direct → fenced →
// balanced-braces.
export function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* swallow */
    }
  }
  return null;
}

// ---------- Catalyst accumulation ----------
//
// Catalysts are not versioned the way other modules are. Each scan adds to
// a growing knowledge base — duplicates merge, dismissals stay sticky so
// they don't get re-added on the next run. The valuation model keeps its
// version-history semantics (Phase 2); only catalysts accumulate.

export type CatalystHorizon = "near_term" | "medium_term" | "long_term";

export type CatalystEntry = {
  id: string;
  title: string;
  type: string;
  horizon: CatalystHorizon;
  description: string;
  expected_date: string | null;
  impact_direction: "bullish" | "bearish" | "neutral";
  impact_magnitude: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  source_context: string | null;
  first_found_at: string;
  last_confirmed_at: string;
  scan_count: number;
  dismissed: boolean;
};

export type CatalystOutput = {
  catalysts: CatalystEntry[];
  overall_catalyst_score: "rich" | "moderate" | "sparse";
  summary: string | null;
  next_earnings: { date: string; daysAway: number | null } | null;
};

// What the parser hands back per Perplexity scan — no metadata yet.
export type FreshCatalyst = Omit<
  CatalystEntry,
  "id" | "first_found_at" | "last_confirmed_at" | "scan_count" | "dismissed"
>;

const CATALYST_STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "with",
  "at", "by", "from", "into", "next", "new", "this",
]);

function catalystTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !CATALYST_STOPWORDS.has(w)),
  );
}

function titleOverlapRatio(a: string, b: string): number {
  const ta = catalystTokens(a);
  const tb = catalystTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  ta.forEach((w) => {
    if (tb.has(w)) common++;
  });
  return common / Math.min(ta.size, tb.size);
}

function isMatch(existing: CatalystEntry, fresh: FreshCatalyst): boolean {
  // Same type + same expected_date is a strong structural match — different
  // wordings of the same upcoming event (e.g. "Q3 earnings guide" vs
  // "guidance update Q3").
  if (
    existing.type === fresh.type &&
    existing.expected_date &&
    fresh.expected_date &&
    existing.expected_date === fresh.expected_date
  ) {
    return true;
  }
  // Title overlap > 70% of the smaller token set — symmetric, robust to
  // paraphrasing.
  return titleOverlapRatio(existing.title, fresh.title) > 0.7;
}

export function catalystScoreFor(
  catalysts: ReadonlyArray<Pick<CatalystEntry, "dismissed">>,
): "rich" | "moderate" | "sparse" {
  const active = catalysts.filter((c) => !c.dismissed).length;
  if (active >= 4) return "rich";
  if (active >= 2) return "moderate";
  return "sparse";
}

function synthSummary(fresh: string | null, activeCount: number): string {
  const word = activeCount === 1 ? "catalyst" : "catalysts";
  const prefix = `Tracking ${activeCount} ${word} across all scans.`;
  return fresh ? `${prefix} ${fresh}` : prefix;
}

export function mergeCatalystResults(
  existing: CatalystOutput | null,
  newResults: {
    catalysts: FreshCatalyst[];
    summary: string | null;
    next_earnings: CatalystOutput["next_earnings"];
  },
): CatalystOutput {
  const now = new Date().toISOString();
  const stamp = (c: FreshCatalyst): CatalystEntry => ({
    ...c,
    id: randomUUID(),
    first_found_at: now,
    last_confirmed_at: now,
    scan_count: 1,
    dismissed: false,
  });

  if (!existing) {
    const catalysts = newResults.catalysts.map(stamp);
    return {
      catalysts,
      overall_catalyst_score: catalystScoreFor(catalysts),
      summary: synthSummary(newResults.summary, catalysts.length),
      next_earnings: newResults.next_earnings,
    };
  }

  // Old rows pre-dating accumulation may lack id/dismissed — backfill so
  // matching/dismiss behaviour stays consistent.
  const merged: CatalystEntry[] = existing.catalysts.map((c) => ({
    ...c,
    id: c.id ?? randomUUID(),
    first_found_at: c.first_found_at ?? now,
    last_confirmed_at: c.last_confirmed_at ?? now,
    scan_count: c.scan_count ?? 1,
    dismissed: c.dismissed ?? false,
  }));

  for (const fresh of newResults.catalysts) {
    const idx = merged.findIndex((m) => isMatch(m, fresh));
    if (idx >= 0) {
      const m = merged[idx];
      // Update fields with newer wording but keep identity / dismissed /
      // first_found_at intact. A previously-dismissed match stays dismissed
      // — that's the whole point of dismissing it.
      merged[idx] = {
        ...m,
        title: fresh.title,
        type: fresh.type,
        horizon: fresh.horizon,
        description: fresh.description,
        expected_date: fresh.expected_date ?? m.expected_date,
        impact_direction: fresh.impact_direction,
        impact_magnitude: fresh.impact_magnitude,
        confidence: fresh.confidence,
        source_context: fresh.source_context ?? m.source_context,
        last_confirmed_at: now,
        scan_count: m.scan_count + 1,
      };
    } else {
      merged.push(stamp(fresh));
    }
  }

  const activeCount = merged.filter((c) => !c.dismissed).length;
  return {
    catalysts: merged,
    overall_catalyst_score: catalystScoreFor(merged),
    summary: synthSummary(newResults.summary, activeCount),
    next_earnings: newResults.next_earnings,
  };
}
