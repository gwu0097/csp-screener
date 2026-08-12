// Tradable Grade — "can I sell this and get paid": POP bands, the
// yield/liquidity gate (opportunityGrade, which already embeds noBid
// and the graduated liquidity cap from lib/liquidity.ts), and the
// personal-history boost/drop modifier.
//
// This is the restructured replacement for the crush/overhang/VIX-
// laden cascade calculateThreeLayerGrade used to compute finalGrade
// with. The grade audit found crush graded F on DDOG, SNDK, and ELF —
// all three profitable trades — so pop_override_on_failing_crush
// wasn't a defect, the old cascade was correctly routing around a
// component that doesn't predict; this rewrite just removes that
// component from the ladder instead of routing around it. Overhang and
// VIX are removed too — those are risk claims about THIS specific
// event, not questions of "will the trade pay if it goes right," so
// they now feed lib/risk-score.ts instead. The old crush/overhang/VIX
// cascade stays computed, unmodified, as `finalGrade` — the "legacy
// grading" panel reads that.
//
// Zero server dependencies, same reasoning as lib/liquidity.ts: shared
// verbatim by lib/screener.ts (server, calculateThreeLayerGrade) and
// components/screener-view.tsx (client, the CustomStrikeAnalyzer/
// OptionsChainTab what-if preview) — one function, not two hand-kept-
// in-sync cascades. The client used to carry its own full replica
// (gradeFromRulesClient) of the crush/overhang/VIX cascade for this
// exact reason; now that the cascade has nothing server-specific left
// in it, there's no reason for that duplicate to keep existing.

export type Grade = "A" | "B" | "C" | "F";

function dropGrade(g: Grade): Grade {
  if (g === "A") return "B";
  if (g === "B") return "C";
  return "F";
}

function boostGrade(g: Grade): Grade {
  if (g === "F") return "C";
  if (g === "C") return "B";
  if (g === "B") return "A";
  return "A";
}

export type TradableResult = {
  grade: Grade;
  matchedRule: "A" | "B" | "C" | "F";
  // True when a genuinely good-POP trade got routed to F only because
  // opportunityGrade is F (thin/no premium, or liquidity-capped to
  // nothing) — this trade isn't bad-odds, it's just not worth pricing.
  // UI should show "Unrated" instead of the bare letter when true.
  unrated: boolean;
};

// `penalty` is newsContext.gradePenalty (a negative-sentiment news
// penalty, distinct from hasActiveOverhang) — kept in the C-rule gate
// exactly as it was before this restructure. Only hasActiveOverhang and
// vix were named for removal; penalty wasn't, so it stays.
export function computeTradableGrade(params: {
  pop: number;
  opportunityGrade: Grade;
  penalty: number;
  personalModifier: "boost" | "drop" | null;
}): TradableResult {
  const { pop, opportunityGrade, penalty, personalModifier } = params;
  let grade: Grade;
  let matchedRule: "A" | "B" | "C" | "F";
  let unrated = false;

  if (pop >= 0.9 && opportunityGrade !== "F") {
    grade = "A";
    matchedRule = "A";
  } else if (pop >= 0.83) {
    if (opportunityGrade === "F") {
      grade = "F";
      matchedRule = "F";
      unrated = true;
    } else {
      grade = "B";
      matchedRule = "B";
    }
  } else if (pop >= 0.75 && penalty > -15) {
    if (opportunityGrade === "F") {
      grade = "F";
      matchedRule = "F";
      unrated = true;
    } else {
      grade = "C";
      matchedRule = "C";
    }
  } else {
    grade = "F";
    matchedRule = "F";
  }

  // Unrated trades never boost — a good win rate on past trades can't
  // manufacture reward that isn't there at THIS strike. Mirrors the
  // legacy cascade's identical guard.
  if (personalModifier === "boost" && !unrated) grade = boostGrade(grade);
  else if (personalModifier === "drop") grade = dropGrade(grade);

  return { grade, matchedRule, unrated };
}

export function tradableRuleText(params: {
  pop: number;
  opportunityGrade: Grade;
  penalty: number;
  matchedRule: "A" | "B" | "C" | "F";
}): string {
  const popPct = (params.pop * 100).toFixed(0);
  switch (params.matchedRule) {
    case "A":
      return `Rule A matched: POP ${popPct}% ≥ 90%, opportunity ${params.opportunityGrade} (not F).`;
    case "B":
      return `Rule B matched: POP ${popPct}% ≥ 83%.`;
    case "C":
      return `Rule C matched: POP ${popPct}% ≥ 75%, penalty ${params.penalty} > −15.`;
    case "F":
      return `No rule matched${params.pop < 0.75 ? ` (POP ${popPct}% < 75%)` : params.penalty <= -15 ? ` (penalty ${params.penalty} ≤ −15)` : ""}.`;
  }
}
