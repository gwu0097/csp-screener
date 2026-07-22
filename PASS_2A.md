# PASS 2A — Structural Fixes to the CSP Screener's Crush/Loss/Implied-Move Logic

Scope: three structural fixes (implied move, EV loss model, crush calibration cap), each with sequential checkpoints and held-out validation, per the governing brief. Builds on `AUDIT_FINDINGS.md` and `FIX_PASS_1.md`.

## The actual headline

We set out to fix three pieces of grading logic. We fixed all three. In validating them, the finding that mattered more than any individual fix is this: **every one of the three terminated at the same wall, and it was never the logic.**

- Fix A's implied-move formula is correct and verified (0.78–0.82x against the theoretical constant). It's the one fix that is unconditionally live today, because it only depends on data that already exists in full — a live Schwab options chain.
- Fix B's loss model is correctly decoupled from the strike formula, can go materially negative, and is backed by a real empirical tail (4.2% breach rate, fatter than a lognormal's ~2%). But the shrinkage ladder that's supposed to differentiate loss depth by ticker/sector is dormant for every single held-out candidate, because there are only **6 confirmed breach events in the entire system**, spread across 6 different sectors. No amount of correct code turns 6 events into a distribution.
- Fix C's calibration cap is correctly built around per-event ratios now (after being built wrong once — see below), decoupled from the additive composite score. But it's live for **1 name out of 60** in the held-out set, because only ~19% of historical implied-move data is Schwab-verified; the other 81% is either an LLM's guess or a value with literally no traceable code path in this repository.

The grading mechanisms built this pass are now **ahead of the data feeding them.** All three fixes are correct and none of them is fabricating differentiation to compensate — they honestly report "not enough verified evidence yet" and default to conservative, non-differentiating behavior. That's the right thing for them to do. But it means the highest-value work after this pass is not more grading code — it's data integrity and forward capture: keep `persistLiveImpliedMove` running so the Schwab-verified pool actually grows, and decide what (if anything) to do about the perplexity/polygon-sourced 81% of historical implied moves that the code now correctly refuses to trust.

---

## Fix A — implied move from the straddle

**Status: live, verified, no known issues.**

- Changed implied move from a single ATM put's `IV × √t` to the ATM straddle's `mid / spot`.
- ATM strike: nearest strike, not interpolated between bracketing strikes — stated as a judgment call (matches the existing `pickAtmContract` convention elsewhere in the codebase; interpolation would buy marginal precision for real complexity on what is a screening signal, not a live straddle trade).
- Straddle legs priced at mid (bid+ask)/2, not bid — deliberately different from Pass 1's bid-only premium decision, because this is a market *measurement*, not a *transaction*; mid is the standard unbiased convention for expected-move estimates.
- No adjustment/scaling factor applied to the raw straddle/spot ratio. Looked for a principled, non-empirical justification for one and found none; picking a specific factor without a real derivation would have been exactly the "back-solve a constant" the brief forbade.
- Fallback: if no usable straddle (missing chain, missing bid/ask on a leg, or strike-grid mismatch), falls back to the old IV×√t formula, flagged via `impliedMoveMethod: "iv_formula_degraded"` and `impliedMoveDegradedReason` — never silent.
- **No-arbitrage floor** (added after live verification surfaced FBP): a leg's bid can never be below its own intrinsic value; a sub-intrinsic bid is a stale/unquotable print, not a real price. Hard invariant, not a tunable threshold.
- **ATM-distance flag** (same FBP investigation): flags — doesn't kill — a straddle whose nearest strike sits far enough from spot that intrinsic value materially contaminates the reading. Threshold derived from the method's own structure: flag when `|spot−strike|/spot > ivFormulaEmPct / 2`, because at that point the algebra puts intrinsic at roughly a third of the reported straddle price. Fired 0/48 times in the held-out set — the no-arbitrage floor already intercepts the severe cases before this flag gets a candidate to look at.
- **Monthly-expiry fallback**: when no weekly exists at the earnings-driven Friday, searches out to +60 days and uses the nearest available expiry instead, flagged via `expirySource: "monthly_fallback"`. Pulled forward from the original backlog because it was blocking held-out validation entirely (4/54 names resolved a chain without it; 25/27, then 60/64, with it).
- **Production bug fixed**: `daysToExpiry` was anchored on `max(earningsDate, today)` for both expiry selection *and* the option's time-to-expiration — correct for the former, wrong for the latter. A BMO name reporting tomorrow, screened today, understated its own contract's real time value by a day. Fixed to always anchor dte on today. This was also the root cause of an apparent 2.3–3.3x "scaling bug" found during held-out testing — that anomaly turned out to be a test-harness artifact (far-future synthetic earnings dates triggering the same class of bug at a much larger scale), not a production issue; production only ever screens same-day earnings, where the divergence was 1 day, not 2 weeks.

**Verification:** ratio of new (straddle) EM to old (IV×√t) EM across the 5 fixtures, live: 0.815–0.824. Theoretical Brenner-Subrahmanyam constant for a continuous-diffusion ATM straddle is ≈0.7979. Close match. At dte=2 specifically, the ratio runs higher (0.95–1.07 across several held-out names) — not a bug: at very short DTE the straddle is correctly pricing discrete earnings-jump risk that the continuous IV×√t formula can't see, which is exactly the divergence Fix A exists to capture.

---

## Fix B — break the strike/EV identity

**Status: live and correctly decoupled. Loss-DEPTH differentiation built but dormant.**

**Before:** `assignmentLoss = max(strike − currentPrice×(1−2×emPct), 0) × 100`. Since Stage 4's strike selection used the *identical* `currentPrice×(1−2×emPct)` formula, this collapsed to ≈0 on every candidate by construction — a hard mathematical identity, not a calibration issue. This was the audit's "EV is 93–100% of premium on every candidate" finding.

**After:** `assignmentLoss = emPct × lossMultiplier × currentPrice × 100`. No reference to `strike` or any strike-mimicking reconstruction anywhere. `lossMultiplier` is a real, measured quantity — the mean overshoot (in EM-units) among historical events, across the whole ticker universe, that breached a 2×EM strike — via a shrinkage ladder:

- Ticker tier, sector tier, global pool (backstop) — reused pattern, not reinvented: same shape as Layer 2's `getPersonalHistory` graduated weights.
- Weight gated on **breach count**, not total event count: `<5 → weight 0 (dark)`, `[5,10) → 0.5`, `≥10 → 1.0`. Derivation: below 5, a bucket's "mean overshoot" is 1–4 anecdotes, not a distribution.
- **Sector rung explicitly killed for this pass**, not just left thin: audited real sector-level breach data and found the 6 total global breach events land in 6 *different* sectors — no slice of 6 is a distribution, and building sector pooling on top of it would have been theater. Shipped global-flat by decision, not by default.
- Computed at read time from raw `(implied_move_pct, actual_move_pct)` pairs in `earnings_history` — no backfill run, no reliance on the mostly-empty `breached_two_x_em`/`two_x_em_strike` columns.
- Global pool: 143 paired events, 6 breached past 2×EM (**4.2%**), mean overshoot **0.331 EM-units** beyond the strike. This tail is fatter than a lognormal would predict (~2% mass past 2σ-equivalent) — a real, keep-worthy finding independent of anything else in this pass.
- `lossMultiplierSource` (`ticker`/`sector`/`pool`) threaded all the way to the grading layer (`ThreeLayerGrade.industryFactors`), not just the raw output payload, so downstream consumers can segment on it.

**Unit tests** (`Test/test-three-layer.ts`, cases 10–12): forced EV to −$113.95 (−228% of premium) on a volatile, closer-to-money candidate; confirmed a calm candidate stays at +$31.76 (+64%) using the *same* multiplier — proving the swing comes from POP/EM, not a hidden per-candidate multiplier; confirmed the multiplier and source flag both flow end-to-end (a hypothetical higher ticker-tier multiplier strictly lowers EV).

**Held-out result, stated honestly:** `lossMultiplierSource = "pool"` for **60/60 (100%)** of held-out candidates; `lossMultiplier = 0.3314` for every one of them. No ticker or sector cleared the breach-count bar. **Loss-depth differentiation is dormant everywhere today** — this is the accepted, correct consequence of only 6 breach events existing, not a bug.

**EV-as-%-of-premium**, first pass looked alarming (79% negative) — turned out to be confounded by grading dead trades. Segmented by opportunity-gate status:

| | dead (opportunityGrade F, n=52 of 60) | passing (A/B/C, n=8 of 60) |
|---|---|---|
| median EV-%-premium | −83% | **+11%** |
| median dollar EV | −$10.34 | **+$1.26** |
| negative EV | 19/20 (95%, of those with premium>0) | 3/8 (38%) |

The population that actually matters (candidates that clear the opportunity gate) sits near break-even with real spread either side — not the flat 93–100%-of-premium band from before, and not "mostly broken" either. Median EV in the passing set is thin (+$1.26 on n=8) — a sample-size caveat worth remembering, not a claim of clear profitability.

---

## Fix C — historical calibration as a cap

**Status: live and correctly decoupled — but this is the one that had to be rebuilt twice.**

**Before:** the realized/implied ratio only entered the crush grade via `historicalMoveScore`, one of five additive sub-scores (8/25 points) — a bad ratio could be outvoted by the other four. Audit example: "1.24x avg, inside 67% of 3 events, dangerous" still produced Crush B.

**First rebuild (wrong — caught, not shipped as final):** applied the ratio as a post-hoc ceiling on the composite grade, computed as `medianHistoricalMovePct ÷ today's-current-emPct`. Passed its own unit tests (21/21) and looked like a reasonable, working fix. **It was wrong.** It conflates calibration quality (was vol underpriced *at the time* of each past event) with vol-regime drift (is today's implied vol higher or lower than it used to be for this name) — dividing old realized moves by today's current EM answers a different question than the cap needs to answer. Caught only because the user cross-checked a real number: NOW's crush-history table shows two per-event ratios (1.87x, 1.23x — mean **1.55x**, both computed against each quarter's *own* at-the-time implied move) that this implementation reported as a benign 0.6–0.73x, because today's current EM (11–14%) happens to be well above those two quarters' implied moves (8–9.5%).

**Second rebuild (shipped):** `computeCrushRatioCap` now takes the **mean of each historical event's own realized/implied-at-the-time ratio** (`getCrushHistory`'s per-quarter `ratio` field), never a current-EM denominator.

- **Mean, not median** — explicit judgment call, argued: at the thin n this mechanism actually sees (0–2 events per ticker in practice), a median would let exactly the print that matters most (a single severe miss) get smoothed away. Verified with a constructed case: `[0.6, 0.7, 2.4]` → mean 1.23 (moderate, capped) vs. median 0.7 (benign, uncapped) — the median lets the 2.4x event escape entirely.
- **Severity bands**, derived from the ratio's own meaning, not fit to any fixture: `≤1.0` no cap, `(1.0, 2.0]` moderate → cap B, `>2.0` severe → cap C. 2.0 is not arbitrary — it's the same "how far is far" multiplier already canonical in this codebase (Stage 4's 2×EM strike, Fix B's breach definition), reused rather than invented.
- **Sample-size ladder**, Layer 2's exact shape (`≥5→1.0`, `2–4→0.5`, `1→0.25`, `0→0`), re-keyed to count **only Schwab-verified quarters** (`implied_move_source IN ("schwab","schwab_t0")`) — not `historicalMoves.length`, not total quarters with any implied move.
- **Thin-sample ceiling, independent of severity**: any weight `<1.0`, including `n=0`, ceilings the grade at B regardless of how good the ratio looks — "uncertainty cuts both ways," a name can't certify an A on zero or near-zero verified history.

**Source-quality audit that forced the rebuild's second half:** of 144 `earnings_history` rows with any `implied_move_pct`, only **19%** are Schwab-sourced (live-captured, trustworthy). **64%** are `implied_move_source="perplexity"` — an LLM asked to recall a historical implied move %, filtered only by its own self-reported confidence and a [5%,25%] plausibility band, not verified against real market data. **17%** are `"polygon"` — grepped the entire repository, case-insensitive, and found **zero code paths that produce this value**; its origin is untraceable from the current codebase. Both are excluded from the cap entirely, by decision, not by oversight.

**Second bug, found while re-verifying NOW after the rebuild:** the automated T0/T1 crush-capture cron writes a `schwab_t0` row for a ticker's own *current, not-yet-happened* earnings event, seeding a pre-earnings implied-move snapshot. NOW's own July 22 row had `actual_move_pct = 0.0003` — an intraday sample taken hours before the AMC print even happened, not a real reaction — and was being counted as a "verified historical quarter." Fixed by excluding any `crushHistory` row where `earningsDate === candidate.earningsDate`: that's the live candidate itself, not history.

**Verification — NOW, the case that drove all of this:**

| | before rebuild | after full rebuild |
|---|---|---|
| crushRatio | 0.6–0.73 (medianMove/current-EM, wrong quantity) | `null` (0 Schwab-verified quarters) |
| crushRatioCap | B (via thin-sample ceiling, coincidentally same letter) | B (via thin-sample ceiling, for the *correct* stated reason) |
| crushGrade | C | C (cap doesn't need to intervene — composite already ≤ B) |

Lands at the same letter both times, for entirely different reasons — the first computation was wrong and got lucky on the output; the second is correct and traceable.

**Held-out result (60 names):** **1/60** names (TMUS) has any Schwab-verified quarter at all (n=1). **0/60** cap via ratio severity. **8/60** cap via the thin-sample ceiling alone. Zero rows show a non-null ratio with `verifiedN=0` — the exclusion filter is clean, verified structurally.

---

## The 5 fixtures, live snapshot under the final Pass 2A code

GEV's original checkpoint fixture came back partial (no weekly chain at that expiry). Resolved by the monthly-fallback fix — but as a live re-check today, GEV resolves on its own weekly chain with no fallback needed at all (expiries and chain availability aren't static; this is today's real market state, not a re-test of the original gap).

| symbol | expiry | old EM (IV×√t) | new EM (straddle) | ratio | strike | premium | oppGrade | crushGrade | lossMult. | EV | finalGrade |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GEV | 07-24 (weekly) | 5.40% | 4.45% | 0.824 | 905 | $1.05 | F | F | 0.331 (pool) | +$0.20 | F (unrated) |
| IBKR | 07-24 (weekly) | 3.87% | 3.17% | 0.821 | 88 | $0.10 | F | C | 0.331 (pool) | −$2.16 | F (unrated) |
| COF | 07-24 (weekly) | 2.96% | 2.44% | 0.824 | 192.5 | $0.10 | F | F | 0.331 (pool) | −$3.43 | F (unrated) |
| PM | 07-24 (weekly) | 3.29% | 2.68% | 0.817 | 185 | $0.20 | F | B (cap applied) | 0.331 (pool) | +$1.90 | F (unrated) |
| CME | 07-24 (weekly) | 3.00% | 2.44% | 0.815 | 237.5 | $0.15 | F | B (cap applied) | 0.331 (pool) | −$3.24 | F (unrated) |

All 5 show `opportunityGrade=F` in this live snapshot (real-time bid/premium conditions right now, not a fixed test state — this will move with the market). new/old EM ratio holds tight at 0.815–0.824 across all 5, matching Fix A's verification. `lossMultiplierSource=pool` and the identical 0.331 multiplier for all 5 is the expected, accepted dormant-loss-depth result. PM and CME show `crushRatioCapApplied=true` — both had zero Schwab-verified quarters and a composite grade above B, so the thin-sample ceiling actually pulled them down; GEV/IBKR/COF's composite grades were already at or below B, so the same ceiling had nothing to do.

---

## Fix B × Fix C interaction — confirmed independent, not double-counted

Both mechanisms can penalize the same volatile, thin-premium names (Fix B via loss depth, Fix C via calibration history) — flagged as a risk before implementation. Neither real held-out data (no name currently trips both hard — the two moderate-ratio names in the live crop, DOW and HON, didn't need the cap to fire at all) nor a constructed synthetic check found double-counting:

| scenario | crush grade | EV |
|---|---|---|
| severe ratio (2.3x) + thin premium | **C** (ratio axis fires) | −$50.89, −339% (loss-depth axis fires) |
| severe ratio (2.3x) + healthy premium | **C** (unchanged — history doesn't get erased by one good quote) | +$64.72, +54% (unchanged — a good premium is a good premium regardless of history) |
| benign ratio + thin premium | **A** (no cap — nothing wrong with calibration) | −$50.89 (unchanged — thin premium is thin premium regardless of history) |

The two axes move independently in both directions. They compound only when both are genuinely true, never by referencing each other's output.

---

## Dormant-mechanism table — what's live, what's asleep, what wakes each one

| mechanism | status today | wakes when | trigger |
|---|---|---|---|
| Fix A straddle-derived implied move | **live** (universal) | — | needs only a live Schwab chain; no data-volume dependency |
| Fix A monthly-expiry fallback | **live** (fires whenever no weekly exists) | — | same |
| Fix A no-arbitrage floor / ATM-distance flag | **live** | — | same |
| Fix B global pool loss multiplier | **live** (flat 0.331 for all) | grows more precise automatically as more earnings post | continuous — no threshold, but this rung never differentiates *between* candidates by itself |
| Fix B ticker-tier loss multiplier | **dark**, 0/60 | that ticker accumulates its own breach events | breachN≥5 → weight 0.5; ≥10 → 1.0 |
| Fix B sector-tier loss multiplier | **dark**, by decision (not just thin) | a sector accumulates pooled breach events across peers | same thresholds, sector-pooled — explicitly killed this pass on evidence (6 breaches in 6 sectors), would need real accumulation to reconsider |
| Fix C ratio-severity cap | **dark**, 0/60 | a ticker accumulates Schwab-verified quarters | n≥2 for severe evidence to bite at all; n≥5 for moderate evidence to bite alone |
| Fix C thin-sample ceiling | **live**, 8/60 fired | — | fires whenever verifiedN<5, including 0; this is the only Fix C behavior visibly active today |

Every dark mechanism above is dark by an explicit, auditable threshold — not silently disabled. All of them switch on automatically, with zero code change, the moment real data clears the bar.

---

## Methodological finding worth keeping

Two real bugs shipped past everything except a real-world number check:

1. **Fix C v1's wrong-denominator ratio** passed its own 21 unit tests (which correctly tested the *logic I told it to run*, not whether that logic was the *right* logic), passed the build, and produced a held-out distribution that looked entirely plausible — no crazy outliers, values clustered in a reasonable 0.2–1.2x band. Nothing in that distribution looked wrong. It was wrong for every single ticker with more than one historical event and any real change in implied vol over time. Only caught because the user had one specific number (NOW's 1.55x) from a real source to check my output against.

2. **NOW's own T0 self-contamination** shipped past the *fix* for bug #1, past its own re-verification, and would have shipped past a held-out re-run too if I hadn't specifically re-checked the one name I already had a reason to distrust.

Neither bug would show up in "does the held-out distribution look reasonable" — both produced numbers that were individually unremarkable. Aggregate plausibility checks and unit tests validate internal consistency; they cannot catch a systematically wrong premise applied consistently, because a systematic error looks exactly like a real pattern in aggregate. The only thing that caught either bug was reconciling one specific, independently-sourced real number against what the code actually computed, and refusing to rationalize the gap before understanding it. Worth building into how future validation on this codebase gets done — pick at least one real number per pass and chase the discrepancy to its root, don't stop at "the distribution looks fine."

---

## Judgment calls made this pass (called out, not laundered as derived)

- Fix A: nearest-strike ATM selection over interpolation.
- Fix A: mid-pricing for straddle legs (reasoned, not empirical — different from Pass 1's bid-only premium rule).
- Fix A: no adjustment factor on the raw straddle ratio (explicitly declined to invent one).
- Fix A: ATM-distance flag threshold (`ivFormulaEmPct/2`) — derived from the method's structure, stated as reasoning rather than a hard proof.
- Fix A: monthly-fallback search window (+60 days) — reasonable, not rigorously derived.
- Fix B: `LOSS_LADDER_MIN_BREACH_N=5`, full weight at 10 — rescaled from Layer 2's 1/2/5 trade-count thresholds; the specific numbers are a judgment call, the *shape* is reused.
- Fix B: fallback multiplier (0.331) if the pool ever returns zero breaches system-wide — frozen at the pool's measured value; this path is believed unreachable given current volume, and its use should be treated as a data-availability incident, not normal operation.
- Fix C: severe cap softens to B instead of C at n=1 (a single anecdote can't force the strictest cap alone).
- Fix C: mean over median for per-event ratio aggregation (argued above).
- Ship Fix B global-flat / Fix C schwab-only-and-dark: both were explicit decisions made on evidence gathered this pass (the sector gate check, the source-quality audit), not defaults arrived at by omission.

## What I'd still want to validate that I couldn't

- Whether the ATM-distance flag (0/48 fired) would ever actually catch a live case, or whether the no-arbitrage floor always gets there first in practice.
- Real sector-level differentiation for Fix B once breach events accumulate beyond single digits — untestable until more calendar quarters pass.
- Whether Polygon-sourced historical data is salvageable (i.e., whether there's a legitimate, undocumented source for it) or should be purged — I could only establish that no current code path produces it, not what it actually is.
- A larger passing-population sample for Fix B's EV distribution — n=8 is thin for the "median near break-even" characterization to be load-bearing.
- Whether the T0/T1 capture cron has other instances of the same premature-actual-move-percent bug beyond the one instance (NOW) found here — this was found by accident during a spot-check, not a systematic audit of that pipeline.

## Build/test status

`tsc --noEmit` clean. `npm run build` clean. Unit tests: `Test/test-three-layer.ts` 45/45, `Test/test-crush-ratio-cap.ts` 31/31.

Everything in this pass is committed only up through Pass 1 (`8a55f16`) — Pass 2A's changes are uncommitted pending your review.
