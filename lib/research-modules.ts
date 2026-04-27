// Research module persistence + cache logic. Each module type writes a
// new row to research_modules on every run (history preserved); the
// "latest" lookup returns the most recent non-expired row for that
// (symbol, type) pair. Cache TTL is per-module-type — fundamentals
// update quarterly, catalysts daily-ish, etc.

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
  const expiryDays = MODULE_EXPIRY_DAYS[moduleType];
  const expiresAt =
    expiryDays === null
      ? null
      : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  const ins = await sb
    .from("research_modules")
    .insert({
      symbol: symbol.toUpperCase(),
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

  // Touch the parent stock row's last_researched_at so the home page can
  // show a recently-researched list. Upserts the row if first time.
  const upsert = await sb
    .from("research_stocks")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        last_researched_at: new Date().toISOString(),
      },
      { onConflict: "symbol" },
    );
  if (upsert.error) {
    throw new Error(
      `[research-modules] touch stock(${symbol}) failed: ${upsert.error.message}`,
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
