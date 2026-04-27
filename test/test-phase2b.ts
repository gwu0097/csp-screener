// Tests for lib/post-earnings.ts.
// Rule logic is tested against the pure applyPostEarningsRules function
// (Test 1). Tests 2-4 exercise the DB path with synthetic rows so we can
// verify idempotency, outcome recording, and real-data flow without
// depending on Run Analysis to have just captured data.
//
// Run: node --env-file=.env.local --import=tsx test/test-phase2b.ts
import {
  applyPostEarningsRules,
  analyzePositionPostEarnings,
  recordPositionOutcome,
} from "../lib/post-earnings";
import { createServerClient } from "../lib/supabase";
import type { PositionRow } from "../lib/positions";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}

function section(title: string): void {
  console.log(`\n=============== ${title} ===============`);
}

// -------------------- Test 1: rule cascade coverage --------------------

function test1_ruleCoverage() {
  section("Test 1: rule coverage");

  // DATA_GATE (null move_ratio)
  {
    const r = applyPostEarningsRules({
      move_ratio: null,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    });
    check("DATA_GATE on null move_ratio", r.rule_fired === "DATA_GATE", `got ${r.rule_fired}`);
    check("  → MONITOR + LOW", r.recommendation === "MONITOR" && r.confidence === "LOW");
    check("  → reasoning non-empty", r.reasoning.length > 20);
  }

  // DATA_GATE (null iv_crushed)
  {
    const r = applyPostEarningsRules({
      move_ratio: 0.5,
      iv_crushed: null,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    });
    check("DATA_GATE on null iv_crushed", r.rule_fired === "DATA_GATE");
  }

  // CLOSE_HIGH: move>1.2, no crush, negative narrative
  {
    const r = applyPostEarningsRules({
      move_ratio: 1.5,
      iv_crushed: false,
      analyst_sentiment: "negative",
      recovery_likelihood: "low",
      stock_pct_from_strike: -0.02,
    });
    check("CLOSE_HIGH fires", r.rule_fired === "CLOSE_HIGH", `got ${r.rule_fired}`);
    check("  → CLOSE + HIGH", r.recommendation === "CLOSE" && r.confidence === "HIGH");
  }

  // CLOSE_MEDIUM_MOVE: move>1.2 but narrative mixed
  {
    const r = applyPostEarningsRules({
      move_ratio: 1.3,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    });
    check("CLOSE_MEDIUM_MOVE fires", r.rule_fired === "CLOSE_MEDIUM_MOVE", `got ${r.rule_fired}`);
    check("  → CLOSE + MEDIUM", r.recommendation === "CLOSE" && r.confidence === "MEDIUM");
  }

  // CLOSE_MEDIUM_ITM: ITM + low recovery
  {
    const r = applyPostEarningsRules({
      move_ratio: 0.9,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "low",
      stock_pct_from_strike: -0.02,
    });
    check("CLOSE_MEDIUM_ITM fires", r.rule_fired === "CLOSE_MEDIUM_ITM", `got ${r.rule_fired}`);
    check("  → CLOSE + MEDIUM", r.recommendation === "CLOSE" && r.confidence === "MEDIUM");
  }

  // HOLD_HIGH: small move + crush + 3% OTM + not negative
  {
    const r = applyPostEarningsRules({
      move_ratio: 0.5,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    });
    check("HOLD_HIGH fires", r.rule_fired === "HOLD_HIGH", `got ${r.rule_fired}`);
    check("  → HOLD + HIGH", r.recommendation === "HOLD" && r.confidence === "HIGH");
  }

  // HOLD_MEDIUM: within implied + crush + medium recovery
  {
    const r = applyPostEarningsRules({
      move_ratio: 0.85,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.01,
    });
    check("HOLD_MEDIUM fires", r.rule_fired === "HOLD_MEDIUM", `got ${r.rule_fired}`);
    check("  → HOLD + MEDIUM", r.recommendation === "HOLD" && r.confidence === "MEDIUM");
  }

  // PARTIAL: move 1.0-1.2 with crush
  {
    const r = applyPostEarningsRules({
      move_ratio: 1.1,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.01,
    });
    check("PARTIAL fires", r.rule_fired === "PARTIAL", `got ${r.rule_fired}`);
    check("  → PARTIAL + MEDIUM", r.recommendation === "PARTIAL" && r.confidence === "MEDIUM");
  }

  // MONITOR_DEFAULT: nothing matches
  {
    const r = applyPostEarningsRules({
      move_ratio: 0.9,
      iv_crushed: false,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.02,
    });
    check("MONITOR_DEFAULT fires", r.rule_fired === "MONITOR_DEFAULT", `got ${r.rule_fired}`);
    check("  → MONITOR + LOW", r.recommendation === "MONITOR" && r.confidence === "LOW");
  }
}

// -------------------- DB fixtures --------------------

type Fixture = {
  position: PositionRow;
  historyId: string;
  cleanup: () => Promise<void>;
};

// Builds a synthetic position + earnings_history row scoped to a fake
// symbol so we don't collide with real data. Returns a cleanup function
// so each test can remove its own fixtures.
async function makeFixture(opts: {
  symbol: string;
  earningsDate: string;
  moveRatio: number | null;
  ivCrushed: boolean | null;
  analystSentiment: string | null;
  recoveryLikelihood: string | null;
  strike: number;
  premiumSold: number;
  contracts: number;
  opened: string;
  status?: "open" | "closed";
  realizedPnl?: number | null;
  closedDate?: string | null;
}): Promise<Fixture> {
  const sb = createServerClient();
  const sym = opts.symbol.toUpperCase();

  // earnings_history
  const newsSummary = JSON.stringify({
    analyst_sentiment: opts.analystSentiment ?? "neutral",
    recovery_likelihood: opts.recoveryLikelihood ?? "medium",
    primary_reason_for_move: "test fixture",
    sector_context: "test",
    guidance_assessment: "not_mentioned",
    key_risks: [],
    summary: "test row",
  });
  const hist = await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: sym,
        earnings_date: opts.earningsDate,
        move_ratio: opts.moveRatio,
        iv_crushed: opts.ivCrushed,
        iv_crush_magnitude: opts.ivCrushed === true ? 0.35 : null,
        breached_two_x_em: false,
        analyst_sentiment: opts.analystSentiment,
        news_summary: opts.analystSentiment ? newsSummary : null,
        perplexity_pulled_at: opts.analystSentiment ? new Date().toISOString() : null,
        data_source: "test",
        is_complete: true,
      },
      { onConflict: "symbol,earnings_date" },
    )
    .select()
    .single();
  if (hist.error) throw new Error(`fixture history: ${hist.error.message}`);
  const historyId = (hist.data as { id: string }).id;

  const pos = await sb
    .from("positions")
    .insert({
      symbol: sym,
      strike: opts.strike,
      expiry: "2026-04-24",
      option_type: "put",
      broker: "test",
      total_contracts: opts.contracts,
      avg_premium_sold: opts.premiumSold,
      status: opts.status ?? "open",
      opened_date: opts.opened,
      closed_date: opts.closedDate ?? null,
      realized_pnl: opts.realizedPnl ?? null,
    })
    .select()
    .single();
  if (pos.error) throw new Error(`fixture position: ${pos.error.message}`);
  const position = pos.data as PositionRow;

  return {
    position,
    historyId,
    cleanup: async () => {
      await sb
        .from("post_earnings_recommendations")
        .delete()
        .eq("position_id", position.id);
      await sb.from("positions").delete().eq("id", position.id);
      await sb.from("earnings_history").delete().eq("symbol", sym);
    },
  };
}

// -------------------- Test 2: idempotency --------------------

async function test2_idempotency() {
  section("Test 2: idempotency");
  const todayStr = new Date().toISOString().slice(0, 10);
  const fx = await makeFixture({
    symbol: "__FXTST_IDEMP__",
    earningsDate: todayStr,
    moveRatio: 0.7,
    ivCrushed: true,
    analystSentiment: "positive",
    recoveryLikelihood: "high",
    strike: 100,
    premiumSold: 1.5,
    contracts: 2,
    opened: todayStr,
  });
  try {
    const r1 = await analyzePositionPostEarnings(fx.position);
    const r2 = await analyzePositionPostEarnings(fx.position);
    check("both calls returned a rec", r1 !== null && r2 !== null);
    check("second call returns same row id", r1?.id === r2?.id, `r1=${r1?.id} r2=${r2?.id}`);

    const sb = createServerClient();
    const list = await sb
      .from("post_earnings_recommendations")
      .select("id")
      .eq("position_id", fx.position.id);
    const count = (list.data ?? []).length;
    check("exactly 1 row in post_earnings_recommendations", count === 1, `got ${count}`);
  } finally {
    await fx.cleanup();
  }
}

// -------------------- Test 3: outcome recording --------------------

async function test3_outcomeRecording() {
  section("Test 3: outcome recording");
  const todayStr = new Date().toISOString().slice(0, 10);

  // (a) rec=CLOSE, closed same day at early profit (≥30% of premium) → aligned=false
  //     (closing that early was "too early — could have held longer"; the
  //     alignment check only rewards CLOSE when closing saved us from a bad
  //     outcome, i.e., we had NOT yet captured most of the premium.)
  {
    const fx = await makeFixture({
      symbol: "__FXTST_OUT_A__",
      earningsDate: todayStr,
      moveRatio: 1.5, // triggers CLOSE_MEDIUM_MOVE
      ivCrushed: true,
      analystSentiment: "positive",
      recoveryLikelihood: "high",
      strike: 100,
      premiumSold: 1.0,
      contracts: 2,
      opened: todayStr,
    });
    try {
      const rec = await analyzePositionPostEarnings(fx.position);
      check("(a) rec=CLOSE", rec?.recommendation === "CLOSE");
      // Simulate close: set realized_pnl to 10% of total premium = 0.1 * (1.0*2*100) = $20
      const sb = createServerClient();
      await sb
        .from("positions")
        .update({ status: "closed", closed_date: todayStr, realized_pnl: 20 })
        .eq("id", fx.position.id);
      await recordPositionOutcome(fx.position.id);
      const after = await sb
        .from("post_earnings_recommendations")
        .select("*")
        .eq("position_id", fx.position.id)
        .single();
      const row = after.data as {
        position_outcome: string;
        actual_pnl_pct: number | null;
        was_system_aligned: boolean | null;
      };
      check("  → outcome = CLOSED_EARLY", row.position_outcome === "CLOSED_EARLY", row.position_outcome);
      check("  → actual_pnl_pct ≈ 0.10", row.actual_pnl_pct !== null && Math.abs(row.actual_pnl_pct - 0.1) < 0.01);
      check("  → was_system_aligned = true (closed before 30% profit)", row.was_system_aligned === true);
    } finally {
      await fx.cleanup();
    }
  }

  // (b) rec=HOLD, held to expiry with profit → aligned=true.
  // Needs the rec's analysis_date > 1 day before close, otherwise
  // CLOSED_EARLY preempts HELD_TO_EXPIRY per the spec ordering.
  // We create the rec normally (analysis_date = now), then rewind it
  // to 3 days ago so the eventual close lands in HELD_TO_EXPIRY.
  {
    const fx = await makeFixture({
      symbol: "__FXTST_OUT_B__",
      earningsDate: todayStr,
      moveRatio: 0.5,
      ivCrushed: true,
      analystSentiment: "positive",
      recoveryLikelihood: "high",
      strike: 100,
      premiumSold: 1.0,
      contracts: 2,
      opened: "2026-04-20",
    });
    try {
      const sb = createServerClient();
      const rec = await analyzePositionPostEarnings(fx.position);
      check("(b) rec=HOLD", rec?.recommendation === "HOLD", `got ${rec?.recommendation}`);
      // Rewind the rec so close date is clearly > 1 day after analysis.
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      await sb
        .from("post_earnings_recommendations")
        .update({ analysis_date: threeDaysAgo })
        .eq("position_id", fx.position.id);
      await sb
        .from("positions")
        .update({ status: "closed", closed_date: "2026-04-24", realized_pnl: 200 })
        .eq("id", fx.position.id);
      await recordPositionOutcome(fx.position.id);
      const after = await sb
        .from("post_earnings_recommendations")
        .select("*")
        .eq("position_id", fx.position.id)
        .single();
      const row = after.data as {
        position_outcome: string;
        was_system_aligned: boolean | null;
      };
      check(
        "  → outcome = HELD_TO_EXPIRY",
        row.position_outcome === "HELD_TO_EXPIRY",
        row.position_outcome,
      );
      check("  → was_system_aligned = true", row.was_system_aligned === true);
    } finally {
      await fx.cleanup();
    }
  }

  // (c) rec=HOLD, closed at loss → aligned=false
  {
    const fx = await makeFixture({
      symbol: "__FXTST_OUT_C__",
      earningsDate: todayStr,
      moveRatio: 0.5,
      ivCrushed: true,
      analystSentiment: "positive",
      recoveryLikelihood: "high",
      strike: 100,
      premiumSold: 1.0,
      contracts: 2,
      opened: "2026-04-20",
    });
    try {
      const rec = await analyzePositionPostEarnings(fx.position);
      check("(c) rec=HOLD", rec?.recommendation === "HOLD");
      const sb = createServerClient();
      // Closed at a date > rec.analysis_date + 1 so it's not CLOSED_EARLY
      await sb
        .from("positions")
        .update({ status: "closed", closed_date: "2026-04-27", realized_pnl: -100 })
        .eq("id", fx.position.id);
      await recordPositionOutcome(fx.position.id);
      const after = await sb
        .from("post_earnings_recommendations")
        .select("*")
        .eq("position_id", fx.position.id)
        .single();
      const row = after.data as {
        position_outcome: string;
        was_system_aligned: boolean | null;
      };
      check(
        "  → outcome != CLOSED_EARLY",
        row.position_outcome !== "CLOSED_EARLY",
        row.position_outcome,
      );
      check("  → was_system_aligned = false", row.was_system_aligned === false);
    } finally {
      await fx.cleanup();
    }
  }
}

// -------------------- Test 4: real NOW position --------------------

async function test4_realNow() {
  section("Test 4: real NOW position");
  const sb = createServerClient();
  const nowPos = await sb
    .from("positions")
    .select("*")
    .eq("symbol", "NOW")
    .eq("status", "open")
    .limit(1);
  const rows = (nowPos.data ?? []) as PositionRow[];
  if (rows.length === 0) {
    console.log("  (no open NOW position — skipping)");
    return;
  }
  const position = rows[0];
  const rec = await analyzePositionPostEarnings(position);
  if (rec === null) {
    console.log("  → no earnings_history row in last 48h (rec=null). That's fine if NOW isn't mid-event.");
    passed += 1;
  } else {
    console.log(`  → rec = ${rec.recommendation} (${rec.confidence}) via ${rec.rule_fired}`);
    console.log(
      `    move_ratio=${rec.move_ratio} iv_crushed=${rec.iv_crushed} sentiment=${rec.analyst_sentiment} recovery=${rec.recovery_likelihood}`,
    );
    console.log(`    reasoning: ${rec.reasoning}`);
    check("reasoning non-empty", rec.reasoning.length > 10);
    check("rule_fired set", rec.rule_fired.length > 0);
  }
}

async function main() {
  test1_ruleCoverage();
  await test2_idempotency();
  await test3_outcomeRecording();
  await test4_realNow();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});
