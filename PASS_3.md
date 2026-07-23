# PASS 3 — Setup/Tradeability Split and Strike-Ladder Walk

Changes what the screener OUTPUTS for a no-bid-at-2xEM candidate — from a bare "Unrated" to an actionable strike recommendation, or an honest "no vol to monetize" skip. Fix A/B/C math is untouched; Fix 2's opportunity gate is untouched.

## The problem

Pass 1's opportunity gate correctly kills the "grade a no-premium trade as tradeable" bug — but it answers "is 2xEM tradeable" when the real question is "is this name worth trading, and at what strike." A good setup with no bid at 2xEM isn't a non-opportunity; it's a good setup whose evaluated strike is in dead air.

## The split

- **setupGrade** — crush, POP (at the 2xEM reference strike), overhang, VIX regime, personal history. Everything except premium. Reuses `finalGrade`'s exact rule cascade with the opportunity/premium clauses removed — not a new mechanism, a subtraction from the existing one.
- **ladderRecommendation** — walks `availableStrikes` (already fetched wide by Fix A; no new Schwab calls) from the 2xEM strike toward the money, looking for the first (least aggressive, not max-yield) rung clearing all three bars:
  - yield ≥ 0.40% — `gradeFromYield`'s existing B threshold, reused
  - |delta| ≤ 0.25 — `scoreDelta`'s existing zero-credit cutoff, reused
  - EM-multiple ≥ 1.0 — derived from the EM's own meaning: below 1x the strike sits *inside* the priced-in move, a categorically different risk posture, not "a bit closer"
- **finalGrade / unrated / opportunityGrade / expectedValue** — unchanged. Fix 2's gate governs them exactly as before this pass.

The ladder's own EV is computed by feeding the recommended strike's real POP/premium into the *same* EV formula (`computeCspExpectedValue`, factored out of `calculateThreeLayerGrade` so there's one copy of the math, not two) — reported as a separate number (`ladderRecommendation.expectedValue`), never overwriting the 2xEM-based `expectedValue`.

## Criterion derivation history (kept for the record)

Two earlier candidates were tried and rejected before landing on the shipped one:
1. *Maximize yield subject to delta≤0.25* — overshoots badly; yield rises monotonically toward the money, so "maximize" always walks to the edge of whatever floor exists (INTC came out at 0.76×EM against a 1.6×EM precedent).
2. *First rung clearing yield≥0.40% (B), delta≤0.25, no EM floor* — well-behaved for high-EM names, but recommends AXP-style strikes barely past the raw implied move for low-EM names, which read as "gave up all cushion for marginal premium."

Shipped: candidate 2 **plus** a hard EM-multiple≥1.0 floor. Verified this exactly reproduces the four example multiples given: INTC 1.57–1.62x, CHTR 1.23–1.35x, DECK 1.20–1.30x, AXP 1.01x (small variance vs. the design-phase numbers is real market movement between sessions, not drift in the logic — see the live-data note below).

**AXP note**: the initial design report proposed tightening the criterion further because AXP's recommended strike gives up nearly all 2x cushion. That was overruled — my (a)/(b) split was a hypothesis from eyeballing 8 rows, not verified ground truth, and the live chain showed a real 14x premium increase at a genuinely tradeable, if aggressive, strike. The criterion does not special-case this; the EM-multiple is printed in the output specifically so a human makes this call, not the tool.

## evExtrapolated

`lossMultiplier` (0.331) was measured as overshoot **past a 2xEM threshold** specifically — every breach event in Fix B's calibration pool was defined relative to 2xEM. Every strike this pass recommends sits at 1.0–1.6×EM. Applying the same multiplier there is a valid formula application but an extrapolation beyond what was measured (a closer strike breaches more often, plausibly with a different typical overshoot-in-EM-units than the 2xEM-specific figure). Not fixed — `evExtrapolated: true` fires whenever the recommended strike differs from the 2xEM reference, surfaced directly in the recommendation text (⚠) so a moved-strike EV is never read with the same confidence as a 2xEM EV.

## Logged for next pass — do not build yet

**The loss multiplier should be a function of strike distance.** Only 6 of the pooled 143 events breached past a 2xEM threshold — the sample this pass's recommended strikes actually need is the conditional overshoot past 1.0–1.6xEM, which the same 143 rows support with a substantially larger breach count (a name breaching 1.25xEM is a much more common event than one breaching 2xEM). Recomputing `computeLossMultiplierLadder`'s conditional-overshoot test at the threshold actually being traded — rather than fixed at 2xEM — closes the calibration gap `evExtrapolated` currently just flags. This is the highest-value follow-up this pass generates; explicitly not built here.

## Rule A / INTC rationale (traced, not inferred)

Original design report predicted INTC's live rationale would read "Rule B matched ... + personal boost → Grade A" based on the user-supplied 8-row table. Pulled the actual live string instead — market movement since that table was captured means today's INTC now reads:

> BOTTOM LINE: No rule matched. Grade F. Skip.

Premium at 2xEM is now $0.15 (was $0.21), pushing `opportunityGrade` to F on this pass, which redirects into the `unrated`/`matchedRule="F"` branch inside Rule B's block. **This is a different, real, smaller finding than what was predicted**: the "F" rationale template (`ruleExplain.F`) only appends a reason when POP<75% or penalty≤−15 — neither applies here, so the bottom line reads as an uninformative bare "No rule matched" even though Rule B's own POP/crush/overhang conditions were actually satisfied and evaluated; the real redirect reason (opportunity gate) is already computed and shown elsewhere in the same text (the CAUTION line: "Opportunity F — premium at $0.15 is thin...") but isn't woven into the terse BOTTOM LINE sentence. Rule A's own text is confirmed accurate by construction (its `crushOk` gate is checked before `matchedRule` can ever become `"A"`) — no fix needed there. The F-template gap is a separate, small, low-risk thing (one string, gated on the existing `unrated` boolean) — flagging it, not fixing it as part of this pass since it wasn't in scope.

## Build/test status

`tsc --noEmit` clean. `npm run build` clean. `Test/test-three-layer.ts` 45/45, `Test/test-crush-ratio-cap.ts` 31/31 — no regressions; the EV refactor into `computeCspExpectedValue` produces byte-identical numbers to the pre-refactor inline version.

## Round 2 — three issues caught before ship

### 1. POP floor added — `LADDER_MIN_POP = 0.95`

The delta≤0.25 bar borrowed from `scoreDelta` was a scoring cutoff (still pays 2pts up to 0.25), not a safety one — it permitted recommendations down to ~75% POP, materially below the 95%+ this strategy targets at 2xEM. Replaced with an explicit `LADDER_MIN_POP = 0.95` gate (computed as `1 - |delta|`, same proxy used everywhere else in the file), pinned directly to the stated 95%+ target rather than a discounted 90%.

**Empirical result, tested against both 90% and 95% on the same 8 names**: at 95%, all 8 skip — nothing in the 1.0–2xEM band clears yield≥0.40% and POP≥95% simultaneously today. At 90%, only INTC clears (barely, at 95% POP on that particular pull — quotes moved between the two live test runs, consistent with everything else in this pass being timestamp-sensitive). The other 7 sit at 80–89% POP wherever their yield is real. This is a structural finding, not a bug: for these 8 names' current implied vols, going from 2xEM to where real premium exists costs roughly 10–20 points of POP, not 5. A floor anywhere near the strategy's own target neutralizes "moved" for most of today's crop — and that's the honest answer (there's genuinely no way to trade several of these within a 95%+ risk tolerance right now), not a defect in the floor. Shipped at 95%; flagged for the user to confirm or override given how few names it lets through in practice.

### 2. Negative-EV framing

`evExtrapolated` already existed; what was missing was that the recommendation text read as an endorsement regardless of the EV's sign. Fixed by branching the text on `expectedValue < 0`: a negative EV on a moved strike is now framed as *likely pessimistic* (the 2xEM-calibrated loss model probably overstates the loss at a materially closer strike — see the logged follow-up above) and the text explicitly redirects the reader to POP/yield/OTM rather than the EV sign. A positive EV keeps a lighter caveat (magnitude approximate, not wrong). No suppression — an extrapolated, unreliable number shouldn't be used as a hard gate in either direction (not to select a strike, not to hide one), so eligibility still runs purely on real chain data (yield, POP, EM-multiple); EV is informational only, worded honestly for its own reliability.

### 3. AXP "measure it" — traced, real root cause found and fixed, not asserted

Dumped AXP's actual live put chain (`safeGetChain`, all strikes $307.50–$377.50). Confirmed the market genuinely moved since the design phase ($341+ spot now vs. ~$327 when the user checked), and — separately — found the original ladder diagnostic text was actively misleading: it reported "nearest real bid" as the first rung with *any* nonzero premium, which is almost always the 2xEM reference strike itself (trivially true, uninformative). The real picture: AXP has several real, live bids between reference and spot ($327.50 @ $1.25–1.18, $330 @ $1.59, $332.50 @ $2.30 across the two pulls) that each fail exactly one of the three bars by a narrow margin — a genuine "dead zone," not a coverage gap. Fixed the skip-branch diagnostic to report the closest **near miss** (highest yield among EM-safe rungs with a real bid) and to name which specific bar(s) it fails and by how much (e.g. "fails yield 0.36% < 0.4% floor, POP 84% < 95% floor") — actionable rather than tautological. No change to `walkStrikeLadder`'s eligibility logic itself; it was already correct, only the explanatory text for the skip case was weak.

## Round 3 — yield bar was the actual binding constraint

The 0.40% yield bar (`gradeFromYield`'s B threshold) was miscalibrated against the strategy it's meant to serve: the user's own A-graded fills (GEV 0.29%, INTC 0.27%, CME 0.26%, TMUS 0.25%, PM 0.21%) are all C-grade by yield alone — A comes from crush/POP/history, not premium richness. Requiring B-grade yield *and* 95% POP simultaneously asked for a strictly better trade than the strategy's own precedent ever takes, which is why round 2 skipped all 8.

Fixed by extracting `YIELD_GRADE_C_THRESHOLD_PCT = 0.2` as a named constant inside `gradeFromYield` and pointing `LADDER_MIN_YIELD_PCT` at it directly — one number, not two hardcoded 0.2s that could drift apart. `LADDER_MIN_POP` stays at 0.95, unchanged.

**AXP**: closed per the user — the POP floor confirms the original (a)/(b) split was right. $327.50 has a real bid because it's ~4% OTM on a 3.8%-EM name, not because there's vol worth selling; at 95% POP its walk range is empty (case b). No further tuning.

### Before/after, all 8 names — final criterion (yield≥0.20%, POP≥95%, EM≥1.0x)

| Symbol | setupGrade | Ladder | Yield | POP | EMx |
|---|---|---|---|---|---|
| INTC | A | **Moved → $78** | 0.24% | 97% | 1.92x |
| CHTR | A | **Moved → $96** | 0.21% | 97% | 1.91x |
| NEM | C | Skip — nearest $90, fails POP (79%<95%) | 0.53% | 79% | 1.00x |
| DECK | B | Skip — nearest $88, fails POP (87%<95%) | 0.51% | 87% | 1.13x |
| AXP | A | Skip — nearest $327.50, fails POP (83%<95%) | 0.36% | 83% | 1.12x |
| DLR | A | Skip — nearest $172.50, fails POP (80%<95%) | 0.52% | 80% | 1.09x |
| NEE | A | Skip — nearest $87, fails POP (81%<95%) | 0.24% | 81% | 1.05x |
| XOM | A | Skip — nearest $152.50, fails both (0.06% yield, 93% POP) | 0.06% | 93% | 1.96x |

Both movers land close to the reference strike (1.9x EM, 97% POP) — the 95% floor only leaves room to move where a name still has real premium *without* giving up much cushion at all. The five POP-blocked skips are the informative case: real, decent yield (0.24–0.53%) exists closer in, but only by paying down into 79–87% POP — a different risk posture, correctly declined. XOM is the true no-vol name: fails on yield even before POP matters. Matches the user's own prediction (INTC clears, genuinely low-vol names skip) plus CHTR clearing for the same structural reason as INTC.

Build clean (`tsc --noEmit`, `npm run build`), `Test/test-three-layer.ts` 45/45, `Test/test-crush-ratio-cap.ts` 31/31 — no regressions.

## Round 4 — direction invariant check, CHTR

Investigated a reported CHTR reference/recommended mismatch (reference $101, recommended $96 — a lower strike, further OTM, wrong direction for a put ladder). Couldn't reproduce live: `rungs` is already filtered to `strike >= referenceStrike` before `eligible` is ever computed, so `best.strike < referenceStrike` should be structurally unreachable, and a fresh live pull for CHTR right now returns `status: "skip_no_tradeable_strike"` (nearest miss $110, 83% POP), not a moved recommendation at all — reference and recommended strike weren't both populated in the response the user was comparing against, at least not from this pull.

What the raw chain dump *did* surface: several nearby strikes carry non-monotonic, likely-stale delta values — e.g. $95 → delta -0.035, $96 → delta -0.031 (a higher put strike should be more negative, not less), several strikes show bid=$0 against wide, oddly-repeated ask/mark values consistent with unquoted/illiquid contracts. This is the most probable explanation for why an earlier pull showed CHTR "moved" to $96 at a suspicious 97% POP — that POP almost certainly came from a corrupted delta on a thin contract, not a real, tradeable edge. Not fixed here (out of scope — Fix A/B/C and the chain-fetch layer are untouched); flagged.

Added a hard assertion regardless, per instruction that a below-reference recommendation must never ship silently: `walkStrikeLadder` now throws if `best.strike < referenceStrike` right before constructing a "moved" result, rather than relying on the filter alone.

Build clean (`tsc --noEmit`, `npm run build`), `Test/test-three-layer.ts` 45/45, `Test/test-crush-ratio-cap.ts` 31/31 — no regressions.

## Timestamp check, this round

Verified live against `getTodayEarnings()` at 1:56pm ET (before the 4pm close): INTC/NEM/DLR/DECK still show `actualEPS: null` — today's AMC earnings haven't printed yet, chains are genuinely pre-earnings.

## Round 5 — delta-monotonicity guard (blocking finding, not deferred)

The stale-delta finding from round 4 was reclassified from "flag, out of scope" to blocking: `LADDER_MIN_POP` is the ladder's only safety gate, and it's entirely delta-derived — a corrupted delta lets a bad quote sail through the one check meant to keep the ladder honest. That's what produced the earlier CHTR "$96, 97% POP" result.

Added inside `walkStrikeLadder`:
- **Zero-bid exclusion**: rungs with `premiumBid === 0` are now filtered out of the walk entirely (`rungs = rungsAll.filter(r => r.premiumBid > 0)`), reusing the same noBid rule `runStageFour` already applies to the suggested strike itself, rather than merely being deprioritized by the existing `premiumBid > 0` eligibility clause.
- **Delta-monotonicity invariant**: for a put, a higher strike's delta must never be less negative than a lower strike's — stated and coded as an invariant (`lastGoodDelta`/`deltaMonotonicityViolation`), not a tunable threshold. A violation means the quote is stale/corrupted, not a market condition. Checked against the last *known-good* delta (skipping already-flagged rungs) so one bad quote can't mask the next one behind it. Flagged rungs are excluded from `eligible` and from the skip-branch's near-miss diagnostic — never silently dropped: `LadderRecommendation` now carries `deltaAnomalyStrikes: number[]` on both branches, and the text appends which strikes were excluded and why, mirroring the `impliedMoveMethod: "iv_formula_degraded"` visibility pattern already used elsewhere in this file.
- Direction assertion from round 4 kept as-is (correct backstop, still unreachable in practice).

**Live rerun, all 8 — which names hit a violation and whether it changed anything:**

| Symbol | Violations found | Effect on recommendation |
|---|---|---|
| DECK | $88, $92 excluded | Near-miss diagnostic shifted from $88 (itself one of the excluded bad quotes) to a clean $87 at nearly the same POP (87%). Verdict unchanged: skip. |
| CHTR | $107, $114 excluded | Neither was ever the winning near-miss ($110 wasn't flagged). Verdict unchanged: skip. |
| INTC, NEM, DLR, AXP, NEE, XOM | None | No effect. |

No verdict flipped in this pull — but DECK's case is the concrete instance the guard exists for: the previously-reported diagnostic number was itself contaminated data, now replaced with a clean one automatically. The CHTR "$96, 97% POP" scenario from round 3 didn't recur in this exact pull (live chain shifted again — INTC's own 2xEM strike is tradeable outright this time, `unrated` is now `false`), but the guard now structurally prevents that class of result whenever a similarly corrupted quote resurfaces, rather than relying on a human noticing.

Build clean (`tsc --noEmit`, `npm run build`), `Test/test-three-layer.ts` 45/45, `Test/test-crush-ratio-cap.ts` 31/31 — no regressions.
