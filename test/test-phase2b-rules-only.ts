import { applyPostEarningsRules } from "../lib/post-earnings";

const cases: Array<[string, Parameters<typeof applyPostEarningsRules>[0], string]> = [
  [
    "DATA_GATE(null move)",
    {
      move_ratio: null,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    },
    "DATA_GATE",
  ],
  [
    "DATA_GATE(null iv)",
    {
      move_ratio: 0.5,
      iv_crushed: null,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    },
    "DATA_GATE",
  ],
  [
    "CLOSE_HIGH",
    {
      move_ratio: 1.5,
      iv_crushed: false,
      analyst_sentiment: "negative",
      recovery_likelihood: "low",
      stock_pct_from_strike: -0.02,
    },
    "CLOSE_HIGH",
  ],
  [
    "CLOSE_MEDIUM_MOVE",
    {
      move_ratio: 1.3,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    },
    "CLOSE_MEDIUM_MOVE",
  ],
  [
    "CLOSE_MEDIUM_ITM",
    {
      move_ratio: 0.9,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "low",
      stock_pct_from_strike: -0.02,
    },
    "CLOSE_MEDIUM_ITM",
  ],
  [
    "HOLD_HIGH",
    {
      move_ratio: 0.5,
      iv_crushed: true,
      analyst_sentiment: "positive",
      recovery_likelihood: "high",
      stock_pct_from_strike: 0.05,
    },
    "HOLD_HIGH",
  ],
  [
    "HOLD_MEDIUM",
    {
      move_ratio: 0.85,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.01,
    },
    "HOLD_MEDIUM",
  ],
  [
    "PARTIAL",
    {
      move_ratio: 1.1,
      iv_crushed: true,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.01,
    },
    "PARTIAL",
  ],
  [
    "MONITOR_DEFAULT",
    {
      move_ratio: 0.9,
      iv_crushed: false,
      analyst_sentiment: "mixed",
      recovery_likelihood: "medium",
      stock_pct_from_strike: 0.02,
    },
    "MONITOR_DEFAULT",
  ],
];

let pass = 0;
let fail = 0;
for (const [label, inputs, expected] of cases) {
  const r = applyPostEarningsRules(inputs);
  const ok = r.rule_fired === expected;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: ${r.rule_fired} → ${r.recommendation} (${r.confidence})`,
  );
  if (ok) pass += 1;
  else fail += 1;
}
console.log(`\n${pass}/${pass + fail} rules correct`);
if (fail > 0) process.exit(1);
