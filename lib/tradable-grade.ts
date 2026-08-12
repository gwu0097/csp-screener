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
//
// Unrated vs. capped-C: opportunityGrade going F has two different
// causes and they now read differently. noBid or a liquidity grade of
// F (lib/liquidity.ts's bottom bucket — essentially no recorded depth
// AND a very wide spread) mean the setup genuinely can't be evaluated
// as a fillable market — that's a hard gate, unrated, same as before.
// A real, evaluable market with a thin premium (yield below the C
// floor, liquidity B or better) is NOT unratable — it's a real trade
// with a poor payoff, so a high-POP name now caps at C instead of
// routing to Unrated. Before this, ANY opportunityGrade-F reason
// produced Unrated, which read a 97%-POP, real-liquidity, thin-yield
// name identically to a 97%-POP name with no bid at all.

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
  // True only for a hard gate (noBid, or a liquidity grade of F) — the
  // setup can't be evaluated at all, as distinct from a real market
  // with a thin payoff (see `capped`). UI should show "Unrated" instead
  // of the bare letter when true.
  unrated: boolean;
  // True when a good-POP band got capped down to C because
  // opportunityGrade is F for an EVALUABLE reason (thin yield, real
  // liquidity) — a real letter, not an absence of one. Mutually
  // exclusive with `unrated`.
  capped: boolean;
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
  // noBid / liquidityGrade determine WHY opportunityGrade is F — see
  // the module comment. Both required (not derived from opportunityGrade
  // alone) so a caller can't silently drift the hard-gate definition.
  noBid: boolean;
  liquidityGrade: Grade;
}): TradableResult {
  const { pop, opportunityGrade, penalty, personalModifier, noBid, liquidityGrade } = params;

  // The letter POP (and, for C, the news penalty) alone would earn,
  // ignoring opportunityGrade entirely.
  let bandGrade: Grade;
  let matchedRule: "A" | "B" | "C" | "F";
  if (pop >= 0.9) {
    bandGrade = "A";
    matchedRule = "A";
  } else if (pop >= 0.83) {
    bandGrade = "B";
    matchedRule = "B";
  } else if (pop >= 0.75 && penalty > -15) {
    bandGrade = "C";
    matchedRule = "C";
  } else {
    bandGrade = "F";
    matchedRule = "F";
  }

  let grade = bandGrade;
  let unrated = false;
  let capped = false;
  if (opportunityGrade === "F" && bandGrade !== "F") {
    const hardGated = noBid || liquidityGrade === "F";
    if (hardGated) {
      grade = "F";
      unrated = true;
    } else {
      grade = "C";
      capped = bandGrade !== "C";
    }
  }

  // Unrated AND capped trades never boost — a good win rate on past
  // trades can't manufacture reward that isn't there at THIS strike.
  // Without the opportunityGrade check, a boost would lift a capped C
  // straight back to B/A, silently defeating the cap.
  if (personalModifier === "boost" && !unrated && opportunityGrade !== "F") grade = boostGrade(grade);
  else if (personalModifier === "drop") grade = dropGrade(grade);

  return { grade, matchedRule, unrated, capped };
}

export function tradableRuleText(params: {
  pop: number;
  opportunityGrade: Grade;
  penalty: number;
  matchedRule: "A" | "B" | "C" | "F";
  capped: boolean;
}): string {
  const popPct = (params.pop * 100).toFixed(0);
  const base = (() => {
    switch (params.matchedRule) {
      case "A":
        return `Rule A matched: POP ${popPct}% ≥ 90%`;
      case "B":
        return `Rule B matched: POP ${popPct}% ≥ 83%`;
      case "C":
        return `Rule C matched: POP ${popPct}% ≥ 75%, penalty ${params.penalty} > −15`;
      case "F":
        return `No rule matched${params.pop < 0.75 ? ` (POP ${popPct}% < 75%)` : params.penalty <= -15 ? ` (penalty ${params.penalty} ≤ −15)` : ""}`;
    }
  })();
  if (params.capped) {
    return `${base}, but capped to C — opportunity ${params.opportunityGrade} (thin yield, real market).`;
  }
  return `${base}, opportunity ${params.opportunityGrade}.`;
}
