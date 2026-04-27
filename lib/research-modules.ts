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
// Pure function — caller passes whatever modules it has and gets a grade
// back. Phase 1 only weights fundamental_health + catalyst_scanner; more
// modules will plug in later.

export type OverallGrade = "A" | "B" | "C" | "D" | null;

export type GradeInputs = {
  fundamentalHealthScore?: number | null; // 0-10
  catalystScore?: "rich" | "moderate" | "sparse" | null;
};

export function computeOverallGrade(
  inputs: GradeInputs,
): { grade: OverallGrade; reasoning: string } {
  const fh = inputs.fundamentalHealthScore ?? null;
  const cat = inputs.catalystScore ?? null;
  if (fh === null && cat === null) {
    return { grade: null, reasoning: "Not yet graded." };
  }
  if ((fh ?? 0) >= 8 && cat === "rich") {
    return {
      grade: "A",
      reasoning: `Strong fundamentals (${fh}/10) with a rich catalyst landscape.`,
    };
  }
  if ((fh ?? 0) >= 6 || cat === "rich") {
    const why =
      cat === "rich"
        ? `Rich catalyst landscape${fh !== null ? ` and decent fundamentals (${fh}/10)` : ""}`
        : `Decent fundamentals (${fh}/10)`;
    return { grade: "B", reasoning: `${why}.` };
  }
  if ((fh ?? 0) >= 4) {
    return {
      grade: "C",
      reasoning: `Mixed signals — fundamentals ${fh}/10${cat ? `, catalysts ${cat}` : ""}.`,
    };
  }
  return {
    grade: "D",
    reasoning: `Weak fundamentals${fh !== null ? ` (${fh}/10)` : ""}${cat === "sparse" ? " and sparse catalysts" : ""}.`,
  };
}

export async function recomputeOverallGrade(symbol: string): Promise<void> {
  const sb = createServerClient();
  const upper = symbol.toUpperCase();
  const fh = await getLatestModule<{ healthScore?: number }>(
    upper,
    "fundamental_health",
  );
  const cs = await getLatestModule<{
    overall_catalyst_score?: "rich" | "moderate" | "sparse";
  }>(upper, "catalyst_scanner");
  const { grade, reasoning } = computeOverallGrade({
    fundamentalHealthScore: fh?.output?.healthScore ?? null,
    catalystScore: cs?.output?.overall_catalyst_score ?? null,
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
