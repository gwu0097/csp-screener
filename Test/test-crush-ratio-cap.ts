// Unit test for Fix C's realized/implied ratio cap (computeCrushRatioCap /
// capGrade), rebuilt around per-event ratios per the PASS_2A source-
// quality audit. Pure functions, no DB — synchronous.
// Run: env -u GEMINI_API_KEY -u PERPLEXITY_API_KEY node --env-file=.env.local --import=tsx Test/test-crush-ratio-cap.ts
import { computeCrushRatioCap, capGrade } from "../lib/screener";

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

// -------- NOW itself: the case that drove this rebuild --------
// Q1'26 ratio 1.868, Q4'25 ratio 1.232 -- IF both were schwab-verified,
// mean = 1.55, moderate severity, n=2 -> weight 0.5 -> thin-sample
// ceiling B (moderate doesn't bite directly at w=0.5, but the ceiling
// still applies). This is what the mechanism SHOULD do when the inputs
// really are verified.
console.log("\n=== NOW's real per-event ratios (if both were schwab-verified) -> mean 1.55x ===");
{
  const r = computeCrushRatioCap([1.8684210526315788, 1.2317224287484512]);
  check("mean lands at 1.55 (matches the real per-event mean)", Math.abs((r.ratio ?? 0) - 1.55) < 0.001, `got ${r.ratio}`);
  check("classified moderate (1.0, 2.0]", r.severity === "moderate");
  check("n=2 -> weight 0.5", r.sampleWeight === 0.5);
  check("cap = B (thin-sample ceiling, moderate doesn't bite alone at w=0.5)", r.cap === "B", `got ${r.cap}`);
}
// But NOW's ACTUAL rows are perplexity + polygon, not schwab -- so the
// real call site passes an EMPTY array (see the n=0 case below), and
// this test also confirms the mean-vs-median choice matters: a naive
// median of these same two numbers would be their midpoint (1.55,
// coincidentally close here since there are only 2 points — the
// difference matters more at 3+ points with one outlier), whereas mean
// weights every event, including the ugly one, equally.
console.log("\n=== mean vs median at n=2 with one much worse print — mean lets it move the number ===");
{
  const rMean = computeCrushRatioCap([0.9, 2.6]); // one benign-ish, one severe
  check("mean = 1.75 (the severe print pulls the average up)", Math.abs((rMean.ratio ?? 0) - 1.75) < 0.001, `got ${rMean.ratio}`);
  check("mean classifies as moderate, not severe, at n=2", rMean.severity === "moderate");
  // A median of [0.9, 2.6] is also 1.75 at n=2 (single midpoint) — the
  // real divergence between mean/median shows up at n=3+, tested next.
}
console.log("\n=== mean vs median at n=3 — the real divergence point ===");
{
  const events = [0.6, 0.7, 2.4]; // two benign, one severe (the "signal, not outlier" case)
  const mean = events.reduce((s, x) => s + x, 0) / events.length; // 1.233
  const sorted = [...events].sort((a, b) => a - b);
  const median = sorted[1]; // 0.7
  console.log(`  mean=${mean.toFixed(3)} median=${median.toFixed(3)}`);
  const r = computeCrushRatioCap(events);
  check(
    "computeCrushRatioCap uses MEAN (1.233, moderate) — a median (0.7, benign/no-cap) would let the 2.4x print escape entirely",
    Math.abs((r.ratio ?? 0) - mean) < 0.001 && r.severity === "moderate",
    `got ratio=${r.ratio} severity=${r.severity}`,
  );
}

// -------- ratio <= 1.0 at full weight: uncapped --------
console.log("\n=== ratio <= 1.0, n=8 (full weight): uncapped ===");
{
  const r = computeCrushRatioCap(new Array(8).fill(0.5));
  check("severity none", r.severity === "none");
  check("weight 1.0", r.sampleWeight === 1.0);
  check("cap null (fully uncapped)", r.cap === null, `got ${r.cap}`);
}

// -------- moderate at full weight -> B --------
console.log("\n=== moderate ratio, n>=5 -> caps at B ===");
{
  const r = computeCrushRatioCap(new Array(6).fill(1.24));
  check("moderate", r.severity === "moderate");
  check("weight 1.0", r.sampleWeight === 1.0);
  check("cap B", r.cap === "B", `got ${r.cap}`);
  check("capGrade(A, B) -> B", capGrade("A", r.cap) === "B");
}

// -------- severe at full weight -> C --------
console.log("\n=== severe ratio (>2x), n>=5 -> caps at C regardless of composite ===");
{
  const r = computeCrushRatioCap(new Array(7).fill(2.2));
  check("severe", r.severity === "severe");
  check("cap C", r.cap === "C", `got ${r.cap}`);
  check("capGrade(A, C) -> C", capGrade("A", r.cap) === "C");
  check("capGrade(F, C) -> F (cap only lowers, never raises)", capGrade("F", r.cap) === "F");
}

// -------- thin sample (n=2): severe still bites at C; moderate needs the ceiling, not the rule, to bite --------
console.log("\n=== n=2, moderate ratio: not capped by the ratio rule alone, but the ceiling still applies ===");
{
  const r = computeCrushRatioCap([1.1, 1.1]);
  check("weight 0.5", r.sampleWeight === 0.5);
  check("moderate", r.severity === "moderate");
  check("cap resolves to B via the ceiling", r.cap === "B", `got ${r.cap}`);
}
console.log("\n=== n=2, severe ratio: DOES bite at C ===");
{
  const r = computeCrushRatioCap([2.4, 2.4]);
  check("n=2, severe -> cap C (not softened to B)", r.cap === "C", `got ${r.cap}`);
}

// -------- n=1: severe caps at B, not C --------
console.log("\n=== n=1, severe ratio: capped at B, not the strictest C ===");
{
  const r = computeCrushRatioCap([3.0]);
  check("weight 0.25", r.sampleWeight === 0.25);
  check("single severe event caps at B, not C", r.cap === "B", `got ${r.cap}`);
}

// -------- thin sample + benign ratio still ceilings --------
console.log("\n=== n=1, benign ratio: STILL can't certify an A ===");
{
  const r = computeCrushRatioCap([0.33]);
  check("severity none", r.severity === "none");
  check("still capped at B", r.cap === "B", `got ${r.cap}`);
  check("capGrade(A, B) -> B", capGrade("A", r.cap) === "B");
}

// -------- n=0: NOW's real case (perplexity/polygon excluded entirely) --------
console.log("\n=== n=0 (no schwab-verified quarters — NOW's actual case): B ceiling, NOT uncapped ===");
{
  const r = computeCrushRatioCap([]);
  check("ratio null (nothing verified to average)", r.ratio === null);
  check("verifiedN = 0", r.verifiedN === 0);
  check(
    "cap = B for the stated reason (zero verified history), not null/uncapped",
    r.cap === "B",
    `got ${r.cap}`,
  );
  check("capGrade(A, B) -> B: NOW cannot read an uncapped 1.55x anymore", capGrade("A", r.cap) === "B");
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
