# CSP Earnings Screener — Audit Findings

Read-only audit. No code changed. All citations are file:line against the
current working tree. Where a claim depends on runtime behavior I couldn't
execute (Perplexity's actual live output, browser rendering), I've said so
explicitly rather than asserting it.

Scope: `lib/screener.ts` (core grading engine, 2289 lines), `lib/perplexity.ts`
(news/sentiment), `lib/crush-context.ts`, `components/screener-view.tsx`
(4567 lines), `components/ticker-intelligence-strip.tsx`,
`app/api/screener/**`, `app/api/intelligence/**`, `lib/market-snapshot.ts`.

---

## Data flow map: field → source → module

| Field | Source | Module |
|---|---|---|
| Implied move (`emPct`) | **Computed** — single ATM *put* contract's IV × √(dte/365). Not a straddle price, not a vendor field. | `lib/screener.ts:539-576` (`pickAtmContract`, `ivPercent`, `expectedMoveFromIv`), consumed in `runStageThree` (`:638`) |
| Delta | **API** — Schwab chain contract's `delta` field, passed through unmodified | `lib/screener.ts:1086` (`runStageFour`) |
| Probability of profit (POP) | **Computed** — `1 − |delta|` | `lib/screener.ts:1884` (`calculateThreeLayerGrade`) |
| IV edge | **Computed** — `weeklyIv / realizedVol30d` (realized vol from 45-day daily closes) | `lib/screener.ts:1910-1913`, `scoreIvEdge` (`:529-537`) |
| Crush grade — **Layer 1 card** | **Computed** — 5-subscore composite (historical-move-ratio, consistency, term structure, IV edge, surprise) vs a DTE-scaled threshold; **overwritten** by a `stock_encyclopedia.avg_move_ratio` fallback when live history has <3 events | `lib/screener.ts:599-774` (`runStageThree`), fallback at `:1455-1483` |
| Crush grade — **header strip** | **Computed independently, in a separate request** — `stock_encyclopedia.avg_move_ratio` or `earnings_history` pairs, via `gradeFromRatio` (does *not* collapse "D" to "F") | `app/api/intelligence/ticker/[symbol]/route.ts:85-105,230-259`, own 15-min cache; `components/ticker-intelligence-strip.tsx` |
| Opportunity grade | **Computed** — `premium/strike × 100`, banded (delta no longer a factor per code comment) | `lib/screener.ts:1084-1096` (`runStageFour`, `gradeFromYield`) |
| Expected value (EV) | **Computed** — `POP×premium×100 − (1−POP)×assignmentLoss`; `assignmentLoss` from a fixed "2×EM downside" point estimate | `lib/screener.ts:1888-1906` |
| Breakeven | **Computed** — `strike − premium` | `lib/screener.ts:1887` |
| "Move calibration" box | **Computed, in the header-strip's own route** — mean(`actual_move_pct/implied_move_pct`) per historical event (each event's *own* period implied move) + % of events where actual < implied | `app/api/intelligence/ticker/[symbol]/route.ts:85-105` (`calibrationFrom`) |
| News sentiment / summary text | **LLM** (Perplexity `sonar`), live call every time, no our-side retrieval or fact grounding | `lib/perplexity.ts:31-59,134-225` (`getEarningsNewsContext`, `buildPrompt`) |
| Crush history table (expanded row) | **Computed** from `earnings_history` rows | `lib/screener.ts` (`getCrushHistory` call at `:1509`), `lib/earnings-history-table.ts` |
| Final grade | **Computed** — rule cascade + overhang/VIX overrides + personal-history modifier | `lib/screener.ts:1971-2062` |
| VS 200D / Target | **API** (Schwab/Yahoo, via shared snapshot cache) — **display-only**, not read by any Stage 1-4 function or `calculateThreeLayerGrade` | source: `lib/market-snapshot.ts`; display: `components/screener-view.tsx:2832-2843,2968-2980` (`FundamentalsBar`, its own independent fetch) |

## The actual final-grade rule (not the summary string)

```ts
// lib/screener.ts:1971-1995
let finalGrade: Grade;
let matchedRule: "A" | "B" | "C" | "F";
if (
  crushOk &&
  probabilityOfProfit >= 0.9 &&
  opportunityGrade !== "F" &&
  !hasOverhang &&
  (vix === null || vix < 25)
) {
  finalGrade = "A";
  matchedRule = "A";
} else if (
  probabilityOfProfit >= 0.83 &&
  (crushOk || probabilityOfProfit >= 0.95) &&
  !hasOverhang
) {
  finalGrade = "B";
  matchedRule = "B";
} else if (probabilityOfProfit >= 0.75 && penalty > -15) {
  finalGrade = "C";
  matchedRule = "C";
} else {
  finalGrade = "F";
  matchedRule = "F";
}
```

**`opportunityGrade` is referenced in exactly one place: the A rule.** The B
and C rules never mention it. This is the literal answer to "find the rule
that lets an F on the reward dimension through" — there is no such gate for
B/C, by construction, not by omission-that-looks-like-a-bug-but-isn't. After
this cascade: an active-overhang or VIX>30 override can drop the grade
further, then a personal-history boost/drop can move it one more level
(`:1997-2055`). None of these overrides reference `opportunityGrade` either.

---

## Findings

### F1 — News/sentiment text: stale periods, stale figures, and one inversion (CME)
- **Severity:** High (this is the user's #1 priority)
- **Location:** `lib/perplexity.ts:31-59` (`buildPrompt`), `:134-225` (`getEarningsNewsContext`)
- **Symptom:** IBKR showed Q1 figures/date labeled as "today, July 21" (actually Q2's date); COF cited ~1-year-stale buyback numbers; CME's characterization of its own reported quarter was inverted (said beat/record, was miss/lagged).
- **Root cause:** The prompt (`lib/perplexity.ts:32`) says only *"reporting earnings tonight or tomorrow morning, search for news from the last 30 days"* — it never states today's date or the specific fiscal quarter being reported, and the returned type (`PerplexityNewsResult`, `:10-17`) has **no structured period/as-of field, no `epsActual`/`epsEstimate`/`revenueActual` field** — the period and every figure the user saw live only as free text inside one `summary` string, with nothing in our code to validate it against. The screener already knows the correct `earningsDate` for the candidate (part of the cache key elsewhere) but this value is never passed into the prompt.
- **Blast radius:** Every candidate's Layer-3/regime narrative, on every screener run — this is not a rare edge case, it's structural to the prompt design.
- **Fix complexity:** Medium. Passing `earningsDate`/expected fiscal period into the prompt and asking the model to explicitly confirm which quarter it found is a prompt change, not an architecture change. Getting a genuinely reliable estimate/actual comparison would need real EPS/revenue data fed to the model (already available via `getEarningsSurpriseHistory`, see F1-related note below) rather than trusting its own live search.
- **Notes:** All three tickers go through the **identical** function/prompt/model/parser (`getEarningsNewsContext`, same call shape at all 3 call sites: `pass3a/route.ts:62`, `pass3/route.ts:197`, `analyze-single/route.ts:112`) — this is **one shared root cause**, not three separate bugs. The CME inversion specifically: there is no code-side beat/miss or record/lagged computation anywhere in this pipeline for this text (the only estimate-vs-actual math in the repo, `getEarningsSurpriseHistory` in `lib/earnings.ts:520-548`, produces a numeric score only, never prose, and its formula is correctly ordered — not swapped). The inversion is Perplexity's own summarization/search-grounding error, not a field-mapping bug in our TypeScript.

### F2 — `getEarningsNewsContext` is called with the ticker as the company name
- **Severity:** Low-Medium (compounds F1, doesn't independently explain it)
- **Location:** `app/api/screener/analyze/pass3a/route.ts:62`, `app/api/screener/analyze/pass3/route.ts:197`, `app/api/screener/analyze-single/route.ts:112` — all three call `getEarningsNewsContext(symbol, symbol)`
- **Symptom:** Not directly visible in the UI, but the prompt's `${companyName}` placeholder (`lib/perplexity.ts:31`) resolves to the raw ticker twice (e.g. "IBKR (IBKR)") instead of a real company name.
- **Root cause:** No call site threads through an actual company name (which the screener does have elsewhere, e.g. `snap?.company_name` in the market-snapshot pipeline).
- **Blast radius:** Every candidate. Likely a smaller contributor for well-known large-cap tickers (IBKR/CME/COF/PM/GEV all resolve fine from ticker alone), but would matter more for thinly-covered or ambiguous tickers.
- **Fix complexity:** Low — thread an existing company-name field through 3 call sites.

### F3 — Two independent "Crush" grades on one screen, no synchronization
- **Severity:** High
- **Location:** Layer 1 card = `tl.industryFactors.crushGrade` (`components/screener-view.tsx:3198,3205,4224`, sourced from `lib/screener.ts:1880`, live Stage-3 computation or the encyclopedia fallback at `:1467-1476`). Header strip = `components/ticker-intelligence-strip.tsx:184-198`, its own `fetch("/api/intelligence/ticker/${symbol}")` (`:84-89`) hitting `app/api/intelligence/ticker/[symbol]/route.ts` (15-min in-process cache, `:43-44`).
- **Symptom:** PM showed "Crush A" (Layer 1) and "Crush B" (header strip) simultaneously.
- **Root cause:** These are **two entirely separate code paths, tables, and caches** with no shared read and no reconciliation. Layer 1's crush is computed live during the screener's server-side run from Yahoo-sourced historical moves scored against *today's* IV (with an encyclopedia fallback only when that live history is thin). The header strip does a completely independent client-side fetch to a different route that reads `stock_encyclopedia.avg_move_ratio` or `earnings_history` pairs, cached separately per-request for 15 minutes. Nothing requires them to agree, and they use genuinely different ratio methodologies (Layer 1's `scoreHistoricalMove`, `lib/screener.ts:502-510`, divides every historical event's move by *today's* live IV-implied move per an explicit code comment at `:489-492`; the header strip's `calibrationFrom`, `app/api/intelligence/ticker/[symbol]/route.ts:85-105`, divides each event by *that event's own* historical implied move).
- **Blast radius:** Every candidate row that renders both surfaces (both are mounted at `components/screener-view.tsx:3189-3210` and again at `:4405-4406`).
- **Fix complexity:** Medium-High. A real fix means picking one canonical crush computation and having both surfaces read it, not patching either display in isolation.
- **Notes:** A second, previously-unflagged bug surfaced during this trace: the header strip's `gradeFromRatio` does **not** collapse a "D" band to "F" the way the Layer-1 fallback explicitly does (`lib/screener.ts:1471`, `g === "D" ? "F" : g`) — meaning the header strip can display a "D" grade that cannot appear anywhere else in the app's declared 4-letter (A/B/C/F) scale.

### F4 — STRENGTH narrative is hardcoded to the grade letter, never checks the actual ratio
- **Severity:** High — this is the direct, reproducible cause of the GEV/PM contradiction
- **Location:** `lib/screener.ts:1923` (`crushOk = crushGrade === "A" || crushGrade === "B"`), `:2091-2094`
- **Symptom:** GEV/PM showed a calibration box reporting a ratio ≥1.0 ("dangerous") while the STRENGTH text unconditionally said "historical moves stay well inside the implied move."
- **Root cause:** Quoted verbatim:
  ```ts
  // lib/screener.ts:2091-2094
  if (crushOk) {
    strengths.push(
      `Crush ${crushGrade} — historical moves stay well inside the implied move; strong IV crush expected.`,
    );
  }
  ```
  This fires whenever `crushGrade` is A or B — a fixed literal string with **zero reference** to the actual ratio, percentage, or sample size that produced that letter. The CAUTION-side F case (`:2116-2120`) is symmetric and equally letter-gated. No client-side narrative generation exists in `components/screener-view.tsx` — the entire `recommendationReason` string is built server-side (`lib/screener.ts:2069+`) and just split/rendered client-side.
- **Blast radius:** Every A/B-crush candidate whose composite score was pulled up by other sub-scores despite a bad historical-move ratio (see F5) — the narrative will misrepresent that specific dimension every time.
- **Fix complexity:** Low-Medium — the fix is mechanical (branch the string on the actual ratio/sub-score, not just the composite letter) but requires deciding what threshold constitutes "well inside" vs "marginal" vs "outside," which is a judgment call, not a pure bug fix.
- **Notes:** Directly answers the user's question — **(b), templated off the grade letter**, not derived from the numbers. Compounds with F3: the ratio the STRENGTH text implicitly contradicts (the calibration box's number) isn't even computed by the same pipeline that produced the grade letter it's templated off of.

### F5 — Crush is a 5-way composite; a badly-overshooting historical-move ratio can be masked
- **Severity:** Medium (design tension, not a clean "bug," but a real contributor to the perceived contradiction)
- **Location:** `lib/screener.ts:502-510` (`scoreHistoricalMove`), `:676` (composite sum), `:482-487` (`gradeFromCrushScore`)
- **Symptom:** GEV's calibration ratio (1.24x) falls in the *worst* bucket of `scoreHistoricalMove`'s own documented bands (`ratio ≥ 1.2 → 0 points`, comment at `:498-499`: "stock consistently overshoots"), yet the overall crush grade was A/B.
- **Root cause:** `crushGrade` is `gradeFromCrushScore(score)` where `score = historicalMoveScore + consistencyScore + termStructureScore + ivEdgeScore + surpriseScore` (max 25, A≥18, B≥14). A 0 on `historicalMoveScore` (worst band) can still be offset by high consistency/term-structure/IV-edge/surprise scores — e.g. 0+4+5+4+4=17 clears the B threshold outright and is one point from A. This is presumably intentional (a genuine multi-factor composite), but it means the single sub-metric surfaced prominently as a standalone "calibration box" can look alarming while the aggregate letter looks fine, with no UI signal explaining *why* they diverge.
- **Blast radius:** Any candidate where one weak sub-score is outweighed by the other four — not rare, structural to a 5-factor composite with compensatory scoring.
- **Fix complexity:** Low to surface (show the sub-score breakdown next to the calibration box); Medium/judgment-call to change the scoring weights themselves.

### F6 — Opportunity grade F reaches a final B/C grade; only the A rule gates on it
- **Severity:** High — exact match to the user's report (IBKR/COF: Opportunity F, final grade B, "size normally")
- **Location:** `lib/screener.ts:1971-1995` (quoted in full above)
- **Symptom:** IBKR and COF graded Opportunity F yet reached final grade B.
- **Root cause:** As shown in the rule cascade — B requires only `POP ≥ 83% AND (crushOk OR POP ≥ 95%) AND !hasOverhang`. `opportunityGrade` never appears in the B or C conditions, or in any of the post-cascade overrides.
- **Blast radius:** Any high-POP, thin-premium name — structurally guaranteed to reach B or better regardless of how bad the reward side is, as long as crush/POP/overhang/VIX line up.
- **Fix complexity:** Low — this is a one-line-per-rule addition (`&& opportunityGrade !== "F"`) if the intent is for reward to matter at every tier; the actual fix requires a decision on whether that's the intended design (opportunity may be *meant* to be advisory-only) or an oversight.
- **Notes:** This functionally makes `opportunityGrade` **decorative for the B and C tiers** — it's computed, displayed, feeds the STRENGTH/CAUTION text (`:2101-2105`), but has no power to stop a final B or C grade. Whether that's "decorative" or "intentionally advisory" is a product question, not something the code answers either way — but as written, an F-opportunity trade can print "Marginal - Size smaller," which reads to a user as an endorsement despite the worst possible reward grade.

### F7 — EV's loss term is structurally near-zero by construction, for the common case
- **Severity:** High — this is the precise, falsifiable explanation for "EV = 93-100% of premium on all five tickers, every time"
- **Location:** `lib/screener.ts:907-908` (`runStageFour`, strike selection) vs `:1898-1904` (`calculateThreeLayerGrade`, loss threshold) vs `:1130-1134` (confirms `suggestedStrike` returned is the *picked contract's real strike*, not the raw math target)
- **Symptom:** EV came in at 93-100% of gross premium on GEV, IBKR, COF, PM, and CME — all five, not a coincidence.
- **Root cause:** The suggested strike is chosen as `candidate.price × (1 − 2×referenceMove)` (`:907-908`, where `referenceMove` prefers the live IV `emPct`). The EV formula's loss threshold, `expectedDownsidePrice`, is computed as `currentPrice × (1 − emPct×2)` (`:1899-1900`) — **the identical formula**, fed the same `emPct` and (confirmed at the call sites, `analyze-single/route.ts:132`, `pass3b/route.ts:145`) the same `currentPrice`. `assignmentLoss = max(strike − expectedDownsidePrice, 0) × 100` (`:1901-1904`), where `strike` is the real chain contract nearest to that same math target (`:1130-1134`, `pickStrikeNearestWithDiff` picks the closest available strike). So for any candidate priced through the standard flow, `strike ≈ expectedDownsidePrice` **by construction** — the picked strike sits at (or within one strike increment of) the exact price point the loss formula treats as the downside floor, making `assignmentLoss` structurally tiny (bounded by roughly half a strike increment in dollars) regardless of how much real tail risk exists beyond that 2×-move boundary. The formula never contemplates a 2.5x or 3x move — that scenario is simply outside what `expectedDownsidePrice` represents.
- **Blast radius:** Every single candidate that reaches Stage 4 with a live IV-derived `emPct` — i.e., the normal/majority case, not an edge case.
- **Fix complexity:** Medium — this isn't a one-line fix; it requires either decoupling the loss-scenario assumption from the strike-selection formula (e.g., model loss at a wider multiple, or integrate over a real distribution) or explicitly documenting that this EV is "expected value assuming the stock doesn't move materially past the suggested strike's own construction," which is a much narrower claim than "expected value."
- **Notes:** This is additive to, not the same as, the separate finding that the loss term (whenever nonzero) is a fixed point-estimate rather than a true `E[loss | breach]` integral (see F8). F7 explains why the loss term is *usually ~0 in absolute terms*; F8 explains that *even when nonzero*, it doesn't model where the stock actually lands.

### F8 — EV loss term is a single point-estimate, not a conditional expectation; and no friction is modeled at all
- **Severity:** High
- **Location:** `lib/screener.ts:1888-1906` (EV formula), `:1077-1078` (premium sourcing), `:1153-1158` (`isSpreadTooWide`, stubbed)
- **Symptom:** User asked whether EV models `E[loss | breach]` or just breach probability, and whether friction (commission, half-spread, assignment) is modeled — flagged IBKR's thin ($0.08-scale) premium as a case where friction would be 20-40% of gross and showed as zero.
- **Root cause, two parts:**
  1. **Loss modeling:** `assignmentLoss` treats the loss-given-breach as a single deterministic dollar amount (`max(strike − expectedDownsidePrice, 0) × 100`, a "the stock lands at exactly this one price" scenario), not an integral over a price distribution below the strike. Mathematically: `EV = P(profit)×premium×100 − P(loss)×[fixed dollar amount]`, a two-point Bernoulli mix, not a continuous conditional expectation. `probabilityOfProfit` (delta-based) and `expectedDownsidePrice` (2×EM-based) are also drawn from two different models of the underlying's distribution, not one consistent one.
  2. **Friction:** Confirmed zero matches anywhere in the file for "commission," "friction," or "fee." Premium is set to the bid-ask **midpoint** (`const mid = (contract.bid + contract.ask) / 2 || contract.mark || contract.last || 0; const premium = mid;`, `:1077-1078`) — not a bid-based, realistically-fillable price — so a real short-put fill (executed closer to the bid) would net less than what's shown, with the shortfall silently absorbed into an optimistic "premium" rather than surfaced as a separate friction line. The one mechanism that used to penalize wide-spread names, `SPREAD_KILL_PCT = 20` (`:141`), is now dead code: `isSpreadTooWide()` (`:1153-1158`) is a stub that always returns `false`, with a comment confirming it's intentional ("Spread is no longer a hard-kill; retained as a display-only field").
- **Blast radius:** Every EV/premium number in the app. Worst on thin-premium names (IBKR-scale) where the midpoint-vs-bid gap and any commission are a large fraction of the (small) premium.
- **Fix complexity:** Friction/commission subtraction: Low (a constant or config-driven per-contract fee). Bid-based premium instead of mid: Low (change one line, re-verify downstream consumers of `premium` expect the more conservative number). Re-enabling a spread gate: Low (uncomment/restore prior logic, if kept). True conditional-expectation loss modeling: High — requires a real distributional assumption, not a formula tweak.

### F9 — Layer 1 (crush) has no sample-size-based confidence weighting; only a binary gate
- **Severity:** Medium
- **Location:** `lib/screener.ts:761` (`insufficientData: historicalMoves.length < 3`), full `calculateThreeLayerGrade` re-traced (`:1872-2062`)
- **Symptom:** Calibration samples ranged 2-14 events, all rendered as equally confident letters.
- **Root cause:** The only sample-size gate for the crush dimension anywhere in the pipeline is the binary `< 3` check that decides whether to substitute the encyclopedia-ratio fallback grade. Once a crush grade is assigned (live-scored or fallback), it participates in the final-grade rule cascade with full weight regardless of whether it was backed by 3 events or 14 — there is no analog to Layer 2's explicit `sampleWeight` ladder (1.0 / 0.5 / 0.25 / 0, `:2007-2055`), which *is* reusable in principle (it's a plain multiplier/threshold-gating pattern) but is not applied to the crush dimension anywhere in the code as written.
- **Blast radius:** Every candidate with a thin historical sample (3-5 events) that clears the binary gate — its crush grade carries the same weight in the final cascade as a 14-event sample.
- **Fix complexity:** Medium — the *mechanism* (a weight multiplier gating boost/drop power) already exists and works for Layer 2; porting the same pattern to Layer 1 is conceptually straightforward, but deciding the right sample-size bands for crush (vs. personal-history's 5+/2-4/1/0) is a judgment call.

### F10 — Implied move is a single-option-IV formula, not a true market-implied move, and understates it
- **Severity:** High (user's priority item; concretely reproduced — GEV 7.7% vs. ~11.5% street)
- **Location:** `lib/screener.ts:539-555` (`pickAtmContract`, puts-only), `:557-561` (`ivPercent`), `:573-576` (`expectedMoveFromIv`), `:607-608,638` (`runStageThree`)
- **Symptom:** GEV's implied move showed 7.7% vs. a ~11.5% street consensus.
- **Root cause:** `emPct = weeklyIv × √(dte/365)`, where `weeklyIv` is the annualized IV of a **single put contract** nearest the money (`pickAtmContract` only reads `chain.putExpDateMap`). This is a textbook annualized-vol-to-time-scaled approximation, not the standard "market-implied move" methodology (ATM straddle mid-price ÷ spot, which directly prices in the earnings-specific vol premium baked into the option's actual price) and not a vendor-supplied implied-move field. This formula is well-known to run cooler than straddle-based implied moves, especially around binary/earnings events where the straddle price captures event-specific richening that a single option's quoted IV (as reported by the data vendor's own model) may not fully reflect.
- **Blast radius:** Every candidate's `emPct` — feeds crush scoring, suggested strike, and the EV loss threshold (see F7) directly, so this single number is load-bearing across the whole pipeline.
- **Fix complexity:** Medium — computing a true straddle-based implied move requires fetching the ATM *call* alongside the put (the chain object likely already carries both sides or would need a small additional fetch) and using `(callMid + putMid) / spot` instead of the IV-formula proxy. Not a new data source, but a real methodology change with downstream re-validation needed (strike selection and EV both currently depend on the old number).
- **Notes on expiry selection:** `buildCandidateFromEarnings` (`:1173-1198`) picks "next Friday on or after" the earnings date with a past-date clamp, but **never consults `earningsTiming` (BMO/AMC)** — the field is stored on the candidate but not read in the Friday-selection logic. This means an AMC report landing on a Friday computes that same Friday as the expiry (delta=0 in `nextFridayOnOrAfter`, `:310-317`), with no explicit check that the weekly contract's last trading session is strictly after the actual release. This is a real, unremediated gap, separate from the peer-events question (F11).

### F11 — No scanning for other companies' earnings inside the expiry window
- **Severity:** Medium
- **Location:** absent by design — confirmed via exhaustive grep across `lib/screener.ts`, `lib/earnings.ts`, `lib/crush-context.ts`, `lib/post-earnings.ts`, `lib/earnings-capture.ts`, `lib/earnings-history-table.ts`, `components/screener-view.tsx`, `app/api/screener/*`
- **Symptom:** GEV (Wed BMO) and Alphabet (Wed AMC) both fell inside the window before a Friday expiry, with nothing in the screener flagging that the expiry window contains other reporting events.
- **Root cause:** No such concept exists. `lib/earnings.ts` does have bulk earnings-calendar fetchers (`getTodayEarnings`, `getEarningsInRange`, `:121-243`) but they're used exclusively to *source the day's candidate list itself* (`app/api/screener/screen/route.ts:128`, `apply-watchlist/route.ts:64`), never to cross-reference a specific candidate's expiry window against what else is reporting in it.
- **Blast radius:** Every multi-week or wide-DTE expiry window that happens to span other earnings; currently invisible.
- **Fix complexity:** Low-Medium if built on the existing bulk calendar fetch (the raw data ingredient already exists); this is a "build a new cross-reference," not a "wire an existing unused value" fix.

### F12 — VS 200D / analyst target: fetched, displayed, zero effect on the grade
- **Severity:** Medium (cheap win once flagged)
- **Location:** Source: `lib/market-snapshot.ts`. Display: `components/screener-view.tsx:2832-2843,2968-2980` (`FundamentalsBar`, own independent `/api/market/snapshot` fetch). Grading: absent from `calculateThreeLayerGrade`'s signature (`lib/screener.ts:1872-1878`) and from every `StageThreeResult`/`StageFourResult` detail field (`:70-135`).
- **Symptom:** "VS 200D" and "TARGET" are visible in the UI; unclear whether they influence anything.
- **Root cause / verdict:** **Already fetched but unused**, specifically in the earnings screener. `vs_sma200_pct` and `analyst_target`/`upside_to_target` are computed and cached via the shared snapshot pipeline and rendered in `FundamentalsBar`, a component that does its own fetch entirely decoupled from Stage 1-4. `calculateThreeLayerGrade` never receives or reads them. (Note: `vs_sma200_pct` *is* consumed elsewhere in the app — `lib/entry-signal.ts:41`, for the unrelated swing screener — so the data-fetching cost is already fully paid; this is a pure wiring gap for the earnings screener specifically.)
- **Blast radius:** None currently (by definition — it's unused), but represents free signal being displayed without being acted on.
- **Fix complexity:** Low — the values are already computed and available; wiring them into a new scoring input is a signature change plus a threshold decision, not a new fetch.

### F13 — No per-ticker "structural predictability" metadata (e.g. CME's monthly ADV pre-release)
- **Severity:** Low (out of scope for a quick fix)
- **Location:** absent by design — `lib/encyclopedia.ts:32-73` (`StockEncyclopedia`, `EarningsHistory` types) enumerated in full; no column or table for disclosure cadence/pre-announcement practices. The only adjacent field, `guidance_assessment` (`lib/encyclopedia.ts:1668` etc.), is a per-event Perplexity-derived sentiment enum, not a static structural fact about the company.
- **Symptom:** CME publicly pre-releases ~90% of its revenue line (monthly ADV) before the print, which materially changes how much "surprise" is even possible — nothing in the screener knows this.
- **Root cause / verdict:** **Not fetched, no such code exists.** Would require a new column (e.g. on `stock_encyclopedia`) or a new lookup table, not a wiring fix.
- **Blast radius:** Affects any name with a similar public-disclosure cadence (monthly sales, comp-sales, etc.) — currently the screener treats every ticker as equally "blind" going into the print.
- **Fix complexity:** Medium — needs new schema and a data-entry/maintenance process (this kind of fact doesn't come from a feed, it has to be curated), not just code.

### F14 — News/sentiment text has no server-side cache/TTL at all
- **Severity:** Medium — directly answers a question the user posed, and the answer is not what a "stale cache" hypothesis would predict
- **Location:** `lib/perplexity.ts` (no `createServerClient` import anywhere in the file); every call uses `cache: "no-store"` (`:104,159`)
- **Symptom/question:** User asked "cache with no TTL?" as a candidate explanation for the stale IBKR/COF/CME text.
- **Finding:** There is **no DB-backed cache for this text at all** — every call is a live, uncached Perplexity request. This is different from the numeric Finnhub data (earnings-surprise history, etc.), which *does* use `finnhub_cache` with an 8-hour TTL (`lib/earnings.ts:64-71,412`) — but that path only ever produces a numeric score, never prose, so it can't be the source of the observed text. The only caching that touches this text is client-side and in-memory: a 24-hour session-scoped reuse window in `components/screener-view.tsx` (`NEWS_REUSE_WINDOW_MS`, `:468`, gated at `:1383`, stored in a `useRef` that resets on page reload), plus persisted `screener_results` rows with a 24h auto-restore freshness gate (`FRESH_WINDOW_MS`, `:340,683`) — **but the manual "Load Previous" button has no age check at all** and will silently repopulate the UI (including `newsSummary`) from however old the latest saved run happens to be.
- **Root cause:** There is no cache to blame for the stale text — each of IBKR/COF/CME's odd results came from a live, uncached call today; the staleness is Perplexity's own search/synthesis, not a code-side caching bug.
- **Blast radius:** The 24h-reuse-with-no-reload-guard is low risk; the "Load Previous" no-age-check is a real, separate latent risk (see closing section, item 3).
- **Fix complexity:** N/A for the "add a TTL" framing, since there's nothing to add a TTL to that would fix F1. The "Load Previous" gap (Low complexity) is a separate, legitimate fix if desired.

---

## Closing

### 1. Findings that collapse into a shared root cause
- **F1 + F2** are the same code path (`getEarningsNewsContext`, identical call shape at all 3 sites) — one root cause (ungrounded prompt, no structured period/figure fields), two symptoms (bad text, and a smaller contributing defect in what's passed to the model).
- **F7 + F8** together fully explain the "EV ≈ premium × POP" pattern: F7 is why the loss term is *usually ~0 in absolute dollars* (strike-selection and loss-threshold share one formula); F8 is why, even when nonzero, it wouldn't represent real tail risk, and why the premium itself is already optimistically priced (mid, not bid) with zero friction on top. These are two independent code facts that compound into the single symptom the user described.
- **F3 + F4 + F5** all contribute to the GEV/PM contradiction but are **not** the same root cause — they're three independent facts (two disconnected crush pipelines, a hardcoded narrative string, and a compensatory composite score) that happen to compound on the same screen. Fixing any one alone would reduce but not eliminate the visible contradiction.

### 2. Ordered fix sequence (risk reduced ÷ blast radius, with dependencies)
1. **F6** (opportunity-F-reaches-B/C) — single-condition addition, zero dependencies, directly stops a specific class of bad recommendation ("size normally" on a thin-premium F). Do first.
2. **F7 + F8 friction/mid-price pieces** — the mid→bid premium change and restoring/deciding on the spread gate are both mechanical and independent of everything else; do before touching the EV formula's loss-modeling shape, since they change the input premium the loss formula operates on.
3. **F4** (hardcoded STRENGTH text) — depends on deciding which ratio/sub-score to reference (relates to F5); do after F5 is resolved conceptually so the text change reflects the real scoring logic, not just adds a second layer of patching.
4. **F5** (composite masking) — a scoring-weight decision; higher judgment cost, do after confirming with stakeholders whether the current compensatory design is intentional.
5. **F1/F2** (news prompt) — independent of the above, but higher implementation cost (needs the correct fiscal period threaded in, ideally cross-checked against real EPS/revenue data already available via `getEarningsSurpriseHistory`). Start once F6 is landed since they don't conflict.
6. **F3** (two crush pipelines) — the highest blast-radius, highest-effort item; requires picking one canonical crush source. Do last, once the individual scoring questions above (F5, F9) are settled, since a unification will inherit whatever those decisions are.
7. **F9, F10, F12** — lower urgency, can proceed independently/in parallel with the above; F12 in particular is cheap (wiring, not new fetch).
8. **F11, F13** — genuinely new features requiring new data cross-referencing or schema; sequence last.

### 3. Something not asked about, but matters more than it might look
The **"Load Previous" button has no staleness check at all** (`components/screener-view.tsx`, `loadPrevious()` around `:717-760`, contrasted with the auto-restore path's `FRESH_WINDOW_MS` gate at `:340,683`). A user could click it and silently get a screener run — News summary, crush grades, everything — from an arbitrarily old saved `screener_results` row with **no visible warning that it's not from today's live run.** Given the user's own top complaint is stale-data-presented-as-current, this button is a second, easy-to-trigger way to reproduce the exact same class of problem, and it wasn't in the original bug list. Worth checking whether any of the five observed tickers were actually viewed via this path rather than a live run — that would change the diagnosis for F1 entirely (a stale saved row, not a live ungrounded Perplexity call).

### 4. What I couldn't determine, and what I'd need
- **Whether the user's 5 test runs were live or via "Load Previous."** This matters a lot for F1: if any of IBKR/COF/CME were loaded from a saved row rather than screened live today, the "no cache/no TTL" conclusion in F14 would need revisiting for that specific ticker. I'd need the actual request logs or the user's recollection of which button they used.
- **Perplexity's actual live response content** for the five tickers today — I traced the code path exhaustively but did not (and per the read-only instruction, should not) make a live API call to reproduce the exact text. Everything about *why* the prompt is prone to this failure is verified from the code; the specific verbatim wrong text is taken as given from the user's report.
- **Whether F5's compensatory composite-scoring design is intentional.** The code has no comment either affirming or disclaiming this behavior — I've flagged it as a design tension, not asserted it's a bug, because I can't determine intent from the code alone.
- **Real-world magnitude of the F10 implied-move gap across tickers beyond GEV** — I confirmed the *mechanism* (single-put-IV formula vs. straddle-based) precisely, but validating "how far off, on average, across the five test tickers" would need either live option chain pulls (not done, read-only + no live calls) or historical logged data I didn't have access to query in this pass.
