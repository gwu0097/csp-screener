// End-to-end test of lib/swing-screener.ts against live Yahoo + Finnhub
// + Schwab. Runs on a 20-symbol subset (NOT the full 550) so it returns
// in seconds; the production POST /api/swings/screen runs the full
// universe and takes 2-5 minutes.
//
// Run: node --env-file=.env.local --import=tsx Test/test-swing-screener.ts

import {
  pass1Filter,
  pass2Enrich,
} from "../lib/swing-screener";
import { SP500_SYMBOLS } from "../lib/stock-universe";

// First 100 S&P 500 names — enough breadth to actually surface some
// pass-1 survivors so the pass-2 enrichment + Tier-1 signals get real
// Finnhub/Schwab data to chew on. The full 550-symbol production scan
// is exercised via POST /api/swings/screen (≈3-5 min); tests stay
// short.
const TEST_SYMBOLS = SP500_SYMBOLS.slice(0, 100);

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
function pct(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—";
}

async function main() {
  console.log(`=== TEST 1: pass1Filter on ${TEST_SYMBOLS.length} symbols ===\n`);
  const t1Start = Date.now();
  const p1 = await pass1Filter(TEST_SYMBOLS);
  const t1Duration = Date.now() - t1Start;
  console.log(
    `[pass1] ${TEST_SYMBOLS.length} → quotes=${p1.quotes.size} → survivors=${p1.survivors.length} in ${t1Duration}ms`,
  );
  if (p1.errors.length) console.log(`[pass1] errors: ${p1.errors.join(", ")}`);

  console.log(`\nSurvivors:`);
  for (const sym of p1.survivors) {
    const q = p1.quotes.get(sym);
    const tl = p1.trades.get(sym);
    const sigs = p1.tier2ByCandidate.get(sym) ?? [];
    if (!q || !tl) continue;
    const fromHigh = (q.currentPrice - q.week52High) / q.week52High;
    const fromLow = (q.currentPrice - q.week52Low) / q.week52Low;
    const vsMa50 = (q.currentPrice - q.ma50) / q.ma50;
    console.log(
      `  ${sym.padEnd(6)} $${fmt(q.currentPrice)} ` +
        `fromHigh=${pct(fromHigh)} fromLow=${pct(fromLow)} vsMA50=${pct(vsMa50)} ` +
        `R/R=${fmt(tl.rr, 2)} tgt=$${fmt(tl.targetPrice)} stop=$${fmt(tl.stopPrice)} ` +
        `analysts=${q.numAnalysts} short=${pct(q.shortPercentFloat ?? 0)} ` +
        `signals=[${sigs.join(",")}]`,
    );
  }

  console.log(`\nDropped:`);
  const droppedSyms = TEST_SYMBOLS.filter((s) => !p1.survivors.includes(s));
  for (const sym of droppedSyms) {
    const q = p1.quotes.get(sym);
    if (!q) {
      console.log(`  ${sym.padEnd(6)} (no quote)`);
      continue;
    }
    const reasons: string[] = [];
    if (q.currentPrice < 10) reasons.push("price<10");
    if (q.marketCap < 500_000_000) reasons.push("mcap<500M");
    if (q.analystTarget === null) reasons.push("no-target");
    const tier2 = (() => {
      const fromHigh = (q.currentPrice - q.week52High) / q.week52High;
      const fromLow = (q.currentPrice - q.week52Low) / q.week52Low;
      const vsMa50 = (q.currentPrice - q.ma50) / q.ma50;
      const volRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
      const sigs: string[] = [];
      if (fromLow <= 0.05) sigs.push("AT_SUPPORT");
      if (q.currentPrice > q.ma50 && vsMa50 < 0.03 && fromHigh < -0.15)
        sigs.push("MA50_RECLAIM");
      if (vsMa50 >= -0.02 && vsMa50 <= 0.02 && fromHigh < -0.1)
        sigs.push("PULLBACK_TO_MA");
      if (fromHigh < -0.4 && volRatio > 1.5 && q.priceChange1d > 0)
        sigs.push("OVERSOLD_BOUNCE");
      return sigs;
    })();
    if (tier2.length === 0) reasons.push("no-tech-setup");
    const tl = (() => {
      const recoveryTarget =
        q.week52Low + (q.week52High - q.week52Low) * 0.6;
      const target =
        q.analystTarget !== null
          ? Math.min(q.analystTarget, recoveryTarget)
          : recoveryTarget;
      const stop = q.week52Low * 0.97;
      const reward = target - q.currentPrice;
      const risk = q.currentPrice - stop;
      const rr = risk > 0 ? reward / risk : 0;
      return { target, rr };
    })();
    if (tl.rr < 2.0) reasons.push(`R/R=${fmt(tl.rr, 2)}`);
    if (q.numAnalysts < 3 && q.numAnalysts > 0)
      reasons.push(`analysts=${q.numAnalysts}`);
    console.log(`  ${sym.padEnd(6)} → ${reasons.join(", ") || "post-tech filter"}`);
  }

  // ---------- TEST 2: pass2Enrich on first 3 survivors ----------
  const probeSet = p1.survivors.slice(0, 3);
  if (probeSet.length === 0) {
    console.log(
      `\n=== TEST 2-4: skipped (pass1 produced 0 survivors) ===`,
    );
    return;
  }
  console.log(
    `\n=== TEST 2: pass2Enrich on ${probeSet.length} survivors: ${probeSet.join(", ")} ===\n`,
  );
  const t2Start = Date.now();
  const candidates = await pass2Enrich(
    probeSet,
    p1.quotes,
    p1.trades,
    p1.tier2ByCandidate,
  );
  const t2Duration = Date.now() - t2Start;
  console.log(
    `[pass2] ${probeSet.length} → ${candidates.length} candidates in ${t2Duration}ms\n`,
  );

  for (const c of candidates) {
    console.log(`--- ${c.symbol} (${c.companyName}) ---`);
    console.log(
      `  price=$${fmt(c.currentPrice)} chg=${fmt(c.priceChange1d, 2)}% ` +
        `vsMA50=${pct(c.vsMA50)} fromHigh=${pct(c.pctFromHigh)} R/R=${fmt(c.rr ?? 0, 2)}`,
    );
    console.log(
      `  setupScore=${c.setupScore}  tier1=[${c.tier1Signals.join(",")}]  ` +
        `tier2=[${c.tier2Signals.join(",")}]  redFlags=[${c.redFlags.join(",")}]`,
    );
    console.log(
      `  insiderSignal=${c.insiderSignal} (${c.insiderTransactions.length} txs, ${c.executiveBuys.length} exec buys)`,
    );
    console.log(
      `  options=${c.optionsSignal} ratio=${fmt(c.callVolumeOiRatio ?? 0, 2)} strike=${c.topOptionsStrike} unusual=${c.unusualOptionsActivity}`,
    );
    console.log(
      `  earnings=${c.nextEarningsDate ?? "—"} (${c.daysToEarnings ?? "—"} days)`,
    );
  }

  // ---------- TEST 3: Tier-1 signal verification ----------
  console.log(`\n=== TEST 3: Tier 1 signal verification ===\n`);
  const strongInsider = candidates.filter((c) => c.insiderSignal === "strong_bullish");
  if (strongInsider.length === 0) {
    console.log("  no strong_bullish insider signals in this sample (ok)");
  } else {
    for (const c of strongInsider) {
      console.log(`  ${c.symbol} executive buys:`);
      for (const tx of c.executiveBuys) {
        console.log(
          `    ${tx.date}  ${tx.name} (${tx.title})  ` +
            `${tx.shares} sh @ $${fmt(tx.price)} = $${fmt(tx.dollarValue, 0)}`,
        );
      }
    }
  }
  const unusualOpts = candidates.filter((c) => c.unusualOptionsActivity);
  if (unusualOpts.length === 0) {
    console.log("  no unusual options activity in this sample (ok)");
  } else {
    for (const c of unusualOpts) {
      console.log(
        `  ${c.symbol} unusual calls: vol/oi=${fmt(c.callVolumeOiRatio ?? 0, 2)} strike=$${c.topOptionsStrike}`,
      );
    }
  }

  // ---------- TEST 4: R/R math sanity ----------
  console.log(`\n=== TEST 4: R/R computation sanity check ===\n`);
  for (const c of candidates) {
    const recoveryTarget = c.week52Low + (c.week52High - c.week52Low) * 0.6;
    const expectedTarget =
      c.analystTarget !== null
        ? Math.min(c.analystTarget, recoveryTarget)
        : recoveryTarget;
    const expectedStop = c.week52Low * 0.97;
    const expectedReward = expectedTarget - c.currentPrice;
    const expectedRisk = c.currentPrice - expectedStop;
    const expectedRr = expectedRisk > 0 ? expectedReward / expectedRisk : 0;
    const targetMatch = Math.abs(c.targetPrice - expectedTarget) < 0.01;
    const stopMatch = Math.abs(c.stopPrice - expectedStop) < 0.01;
    const rrMatch = Math.abs((c.rr ?? 0) - expectedRr) < 0.01;
    console.log(
      `  ${c.symbol}: target ${targetMatch ? "OK" : "MISMATCH"} (got $${fmt(c.targetPrice)} vs $${fmt(expectedTarget)}), ` +
        `stop ${stopMatch ? "OK" : "MISMATCH"} (got $${fmt(c.stopPrice)} vs $${fmt(expectedStop)}), ` +
        `R/R ${rrMatch ? "OK" : "MISMATCH"} (got ${fmt(c.rr ?? 0, 3)} vs ${fmt(expectedRr, 3)})`,
    );
  }

  console.log(
    `\n[done] pass1 ${t1Duration}ms · pass2 ${t2Duration}ms · ${candidates.length} candidates`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
