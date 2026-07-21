# Fix Pass 1 — Scope-Limited Fixes

Working from `AUDIT_FINDINGS.md`. Fixtures captured live via
`app/api/screener/analyze-single` (sandbox mode — no `earnings_history`
writes) against real Schwab/Perplexity data, saved to `fixtures/before/` and
`fixtures/after/`. Candidates use a synthetic near-term expiry (2026-07-24,
3 DTE) since the tickers' real earnings dates from the original audit have
since passed — see the Step 0(b) note below.

---

## Step 0 — investigation (no changes)

### 0(a) — "Load Previous" staleness: **confirmed YES**
`loadPrevious()` (`components/screener-view.tsx:719-776`) has no age check at
all, unlike the auto-restore mount effect (`:683`, explicit `ageMs >=
FRESH_WINDOW_MS` bail-out). It replays the saved `screener_results` row's
`newsSummary`/fundamentals verbatim, however old, with only a benign "Loaded
N candidates from `<timestamp>`" message — no warning styling, nothing
blocking. **You confirmed proceeding with Fixes 2-4; Fix 1 was revised
rather than skipped (see below).**

One piece of supporting evidence surfaced during this pass: my own two live
Perplexity calls for IBKR (the `verify-fix1` check and the final `after`
capture, run minutes apart) both independently retrieved the *same* correct
Q2 figures ($0.51 EPS, $1.48B revenue) — consistent, not stale. This doesn't
prove none of the original 5 tickers went through "Load Previous," but it's
weak evidence that live Perplexity calls today aren't inherently
unreliable — if the original session's bad IBKR output *was* a live call, it
was a worse-than-typical draw, not the norm.

### 0(b) — Golden fixtures: **captured, one caveat**
All 5 tickers captured before and after. **GEV failed at Stage 3/4 in the
`before` capture** ("Schwab chain unavailable for weekly expiry") but
succeeded in the `after` capture with real data. This is a live options-chain
availability fluctuation between the two capture times (minutes apart,
real market data) — unrelated to any of the 4 fixes, which don't touch chain
fetching. Flagging so the GEV row in the diff table below isn't
misread as a fix effect for every field.

### 0(c) — Custom-strike analyzer + EV: **doesn't compute EV at all**
Read `CustomStrikeAnalyzer` (`components/screener-view.tsx:3566+`) end to
end. Its `analyze()` function computes strike, %-drop, premium, delta,
yield%, POP, breakeven, and a grade-impact preview — **there is no EV field
anywhere in `CustomStrikeAnalysis` or its render.** So the literal question
("does the loss term collapse or break the identity when you move off
2×EM?") doesn't have an answer to give — EV is simply never shown for a
custom strike, only for the suggested (2×EM) strike via the main grade
panel. Nothing to observe, nothing changed.

---

## Fix 1 — company name + period anchor (revised per your follow-up)

**1(a) — company name.** Traced every field reaching the 3
`getEarningsNewsContext` call sites and found no company name anywhere in
the existing payload (candidate object, Finnhub calendar source, Schwab
chain type, classification/universe lookups) — confirmed before you
revised the instruction. Per your revision, added a read-only lookup:

- New `getCachedCompanyName(symbol)` in `lib/market-snapshot.ts` — a single
  cached-column `SELECT company_name FROM symbol_market_snapshot`, never a
  live Yahoo refresh. Falls back to the ticker on null/missing/error, never
  throws.
- Wired into all 3 call sites (`pass3a/route.ts`, `pass3/route.ts`,
  `analyze-single/route.ts`), all of which already import/use
  `createServerClient` elsewhere in the app (`pass3a` needed the import
  added; the DB table and client factory already existed — no new
  infrastructure).

**Before → after companyName (all 5 already had a cached snapshot row):**

| Symbol | Before | After |
|---|---|---|
| GEV | `GEV` | `GE Vernova Inc.` |
| IBKR | `IBKR` | `Interactive Brokers Group, Inc.` |
| COF | `COF` | `Capital One Financial Corporati` *(truncated — pre-existing column length limit, not touched)* |
| PM | `PM` | `Philip Morris International Inc` *(same truncation)* |
| CME | `CME` | `CME Group Inc.` |

**1(b) — period anchor.** Added `fiscalPeriodLabel(earningsDate)` (a
standard calendar-quarter heuristic) to `lib/perplexity.ts`, and one new
grounding sentence to the prompt — nothing else in the prompt structure
changed:

```
Before:
For ${companyName} (${symbol}), reporting earnings tonight or tomorrow
morning, search for news from the last 30 days.

After:
For ${companyName} (${symbol}), reporting ${fiscalPeriod} earnings on
${earningsDate}, search for news from the last 30 days.

This is specifically about the UPCOMING ${fiscalPeriod} report due
${earningsDate} — do not use figures, results, or characterizations from a
previously reported quarter as if they describe this one.
```

**Returned news summary, before → after (live calls, real data):**
- **IBKR before** (from the original audit, reproduced): *"reporting Q1 2026
  earnings today, July 21, 2026 ... EPS $0.59, revenue $1.67B"* — wrong
  period label, wrong figures for the date.
- **IBKR after** (this pass, `fixtures/after/IBKR.json`): *"Interactive
  Brokers Group (IBKR) has already reported Q2 2026 earnings on July 21,
  2026, beating estimates with $0.51 EPS and $1.48B revenue"* — consistent
  Q2 framing throughout, no Q1/Q2 conflation. Acceptance criterion met: IBKR
  no longer returns Q1 figures under a Q2 label.
- **GEV after** is a nice unanticipated side effect: *"GE Vernova is
  scheduled to report Q2 2026 earnings on July 22, 2026 (not July 21)..."*
  — the model is now cross-checking the stated date against what it finds
  and flagging the mismatch (my synthetic candidate said "2026-07-21";
  GEV's real date is the 22nd) rather than silently drifting.

I can't claim this is a *guaranteed* fix — Perplexity's live search isn't
fully deterministic even at `temperature: 0` — but the period constraint is
now explicit where before there was none, and every one of the 5 live
calls this pass returned internally consistent period framing.

---

## Fix 2 — opportunityGrade gate on B and C

**Design chosen: `unrated: boolean` flag, `finalGrade` stays `"F"`
internally.** I considered widening the `Grade` type to a 5th value, but
that would ripple into every consumer that assumes 4 letters (sorting,
persistence, the client-side `gradeFromRulesClient` replica, badge
rendering) — a much bigger change than this fix calls for. Instead:
`finalGrade` stays `"F"` (so nothing else in the app needs to know about a
5th state), a new `unrated` boolean marks *why*, and a new `recommendation`
string ("Unrated - below premium floor") replaces "Skip" for this specific
case. The UI shows "Unrated" instead of the bare letter wherever
`finalGrade` is rendered, via a new `displayFinalGrade()` helper (same
existing pattern as `displayCrushGrade()`, which already shows "?" instead
of "F" for insufficient-data crush grades).

Also guarded: the personal-history boost modifier can no longer promote an
unrated trade into a real grade (a >80% win rate on past trades can't
manufacture reward that isn't there at *this* strike) — `unrated` is
checked before `personalModifier` is even set to `"boost"`, so both the
grade math and the override-explanation text stay consistent.

**What I deliberately left alone:** the `bottomLine`/`ruleExplain`
STRENGTH/CAUTION/BOTTOM LINE narrative-generation code is out of scope, so
I did not touch it. One consequence: the `recommendationReason` text block
will still print "Grade F. Skip." in its BOTTOM LINE section for an unrated
trade (since `finalGrade` is `"F"` there and none of that branch's specific
sub-conditions — overhang / POP<75% / penalty≤-15 — apply), even though the
top-level `recommendation` field and the badge correctly say "Unrated."
This is a known, visible inconsistency between two text surfaces that I
did not fix, because fixing it means touching the out-of-scope narrative
code. Flagging explicitly rather than burying it.

**Verified live (IBKR, COF — both had Opportunity F, previously graded B):**

| | IBKR | COF |
|---|---|---|
| finalGrade | F (unrated) | F (unrated) |
| recommendation | Unrated - below premium floor | Unrated - below premium floor |

Neither returns B anymore. All 5 fixtures' final states are in the diff
table below.

---

## Fix 3 — spread hard-kill + bid pricing (revised per your follow-up)

**3(a) — original finding, then revised.** `git log -S SPREAD_KILL_PCT`
showed the spread hard-kill wasn't orphaned dead code — it was deliberately
removed in commit `62daa46` ("Execution cost is not meaningful for
overnight CSP holds"). I surfaced this before touching anything, since it
changes the picture from "restore an accident" to "reverse a reasoned
decision." Per your revision, did **not** restore the spread-percentage
kill. Implemented instead:

- **(a-i) Zero/absent-bid hard kill** — a different, narrower rule than the
  old spread-percentage one. In `runStageFour`: if `contract.bid` is not a
  finite positive number, the contract cannot be sold at any price —
  `opportunityGrade` forces to `"F"` and a new `note: "No bid — cannot be
  sold at any price"` is set. Premium is set to `0` in this case (not a
  mark/last fallback) — showing a fabricated nonzero "premium" for an
  unsellable contract would defeat the point.
- **(a-ii) Bid/ask surfaced as display fields, not a gate.** Added `bid:
  number | null` and `ask: number | null` to `StageFourResult`, populated
  alongside the existing (unchanged) `bidAskSpreadPct`. In the UI, the
  existing spread indicator (previously an amber alert icon shown *only*
  when spread > 50%) now always shows an icon with a tooltip listing bid,
  ask, and spread% whenever the data exists — amber when >50%, a neutral
  info icon otherwise. No grade or kill reads these fields.
- **(a-iii) Logged, not acted on.** One new log line per candidate:
  `[stage4:${symbol}] pricing: bid=... ask=... mid=... premium(bid-priced)=...
  spread%ofMid=... noBid=...` — observability only.

**3(b) — bid pricing.** `premium` in `runStageFour` now sources from
`contract.bid` directly (falling back to `mark`/`last` only when bid itself
is usable but the mid-formula's old `||` chain would have — in practice
this only matters when bid is a valid positive number, which is exactly
when we use it). The mid-based `bidAskSpreadPct` calculation is untouched
(spread% is still conventionally expressed against mid; it's now purely
informational per 3(a-ii), not a scoring input).

**Not fixed, flagged as adjacent:** the custom-strike analyzer
(`CustomStrikeAnalyzer`, `components/screener-view.tsx`) and the manually
editable strike cell (`EditableStrikeCell`) both separately compute a
"premium" from `nearest.mark`, which is *still* mid-priced — the same
`availableStrikes[].mark` field is also used as the denominator for a
spread% calculation in those components, so changing its value to bid-based
would require adding a new field (to avoid overloading one field for two
different purposes) and touching two more render sites. That's larger than
"change premium pricing" and risks scope creep into the custom-strike
tool's data model, so I left it as-is and am flagging it here rather than
quietly expanding the fix.

**Bid / ask / spread% / mid / bid-priced-premium, all 5 fixtures (after):**

| Symbol | Bid | Ask | Spread % (of mid) | Bid-priced premium | Note |
|---|---|---|---|---|---|
| GEV | 0 | 1 | 200% | **0** | No bid — cannot be sold |
| IBKR | 0 | 0.05 | 200% | **0** | No bid — cannot be sold |
| COF | 0.10 | 0.20 | 66.7% | **0.10** | — |
| PM | 0 | 1.15 | 200% | **0** | No bid — cannot be sold |
| CME | 0.05 | 0.25 | 133.3% | **0.05** | — |

Three of five (GEV, IBKR, PM) trip the new no-bid hard-kill. Before this
fix, none of these fields (`bid`, `ask`, `note`) existed on `StageFourResult`
at all — the "before" column is genuinely absent, not zero.

---

## Fix 4 — friction (commission) in EV

Added `commissionPerContract()` to `lib/screener.ts`, reading
`process.env.CSP_COMMISSION_PER_CONTRACT` with a `DEFAULT_COMMISSION_PER_CONTRACT
= 0.65` fallback when unset/invalid — a config value, not an inline literal.
`calculateThreeLayerGrade` takes an optional `commissionOverride` parameter
(defaults to `commissionPerContract()` when omitted) so a future per-user
setting — or my own verification — can pass a specific rate without an env
var or restart.

The subtraction is the last step, after the existing (unmodified)
loss-threshold computation:

```ts
const grossExpectedValue =
  probabilityOfProfit * premium * 100 - (1 - probabilityOfProfit) * assignmentLoss;
const commission = commissionOverride ?? commissionPerContract();
const friction = commission * 2; // entry (sell to open) + exit/assignment
const expectedValue = grossExpectedValue - friction;
```

Your friction-vs-spread reasoning is correct and I implemented it as
stated: commission only, not commission + half-spread, since Fix 3(b)
already prices at bid (entry slippage is captured there, not double-counted
here).

**EV at $0 and $0.65 commission, all 5 fixtures** (the `$0.65` column is
the live captured `after` value; the `$0` column is derived algebraically
— `ev_at_0 = ev_at_0.65 + 2×0.65` — since the subtraction is linear and I
verified the formula directly in code, this doesn't require a second live
run):

| Symbol | EV @ $0 commission | EV @ $0.65 commission | Premium (bid) |
|---|---|---|---|
| GEV | 0.00 | **-1.30** | 0 |
| IBKR | -0.06 | **-1.36** | 0 |
| COF | 9.74 | **8.44** | 0.10 |
| PM | 0.00 | **-1.30** | 0 |
| CME | 4.88 | **3.58** | 0.05 |

IBKR goes materially negative at $0.65 commission, as your acceptance
criterion anticipated — confirmed.

---

## Full diff table — every field that changed, all 5 tickers

| Ticker | Field | Before | After |
|---|---|---|---|
| GEV | (Stage 3/4) | Cannot evaluate — chain unavailable | succeeded (unrelated data fluctuation, see 0(b)) |
| GEV | crushGrade | n/a | B |
| GEV | opportunityGrade | n/a | F |
| GEV | finalGrade / unrated | n/a | F / **true** |
| GEV | recommendation | n/a | Unrated - below premium floor |
| GEV | premium (bid/ask) | n/a | $0 (bid=0, ask=1) |
| GEV | EV | n/a | -1.30 |
| IBKR | crushGrade | B | B (unchanged) |
| IBKR | opportunityGrade | F | F (unchanged) |
| IBKR | finalGrade / unrated | B / — | **F / true** ← Fix 2 |
| IBKR | recommendation | Marginal - Size smaller | **Unrated - below premium floor** ← Fix 2 |
| IBKR | premium | $0.03 (mid) | **$0 (bid=0)** ← Fix 3(b) + 3(a-i) |
| IBKR | EV | 2.97 | **-1.36** ← Fix 3(b) premium drop + Fix 4 friction |
| IBKR | newsSummary | wrong period/figures (original audit) | consistent Q2 framing ← Fix 1 |
| COF | crushGrade | C | C (unchanged) |
| COF | opportunityGrade | F | F (unchanged) |
| COF | finalGrade / unrated | B / — | **F / true** ← Fix 2 |
| COF | recommendation | Marginal - Size smaller | **Unrated - below premium floor** ← Fix 2 |
| COF | premium | $0.13 (mid) | **$0.10 (bid)** ← Fix 3(b) |
| COF | EV | 12.70 | **8.44** ← Fix 3(b) premium drop + Fix 4 friction |
| PM | crushGrade | A | A (unchanged) |
| PM | opportunityGrade | F | F (unchanged) |
| PM | finalGrade / unrated | B / — | **F / true** ← Fix 2 |
| PM | recommendation | Marginal - Size smaller | **Unrated - below premium floor** ← Fix 2 |
| PM | premium | $0.15 (mid) | **$0 (bid=0)** ← Fix 3(b) + 3(a-i) |
| PM | EV | 14.60 | **-1.30** ← Fix 3(b) premium drop + Fix 4 friction |
| CME | crushGrade | A | A (unchanged) |
| CME | opportunityGrade | F | F (unchanged) |
| CME | finalGrade / unrated | B / — | **F / true** ← Fix 2 |
| CME | recommendation | Marginal - Size smaller | **Unrated - below premium floor** ← Fix 2 |
| CME | premium | $0.18 (mid) | **$0.05 (bid)** ← Fix 3(b) |
| CME | EV | 16.80 | **3.58** ← Fix 3(b) premium drop + Fix 4 friction |
| all 5 | companyName sent to news prompt | ticker | real company name ← Fix 1(a) |
| all 5 | news prompt | no period/date anchor | explicit period+date constraint ← Fix 1(b) |
| all 5 | bid / ask / note fields | absent | present ← Fix 3(a-ii)/(a-i) |

**Note on apples-to-apples:** premium/EV before-vs-after reflects *both* a
fix effect (mid→bid pricing, friction subtraction) *and* real market
movement between the two capture times (prices/quotes drift minute to
minute on a live chain) — I did not attempt to hold the market still. The
grade-level changes (finalGrade, unrated, recommendation) are structural
and not affected by that drift.

---

## 1. Which findings collapse into a shared root cause
- All 5 tickers' recommendation change (B → Unrated) is **Fix 2 alone** —
  one rule-cascade change, same cause everywhere it applied.
- All 5 tickers' EV/premium change is **Fix 3(b) + Fix 4 together** — bid
  pricing lowers the premium input, then commission is subtracted from the
  result — two independent mechanisms compounding on the same number, not
  one root cause.
- GEV/IBKR/PM's `note` field and $0 premium are **Fix 3(a-i)** specifically
  (zero bid), distinct from COF/CME's ordinary bid-priced (nonzero) premium
  drop from Fix 3(b) alone.

## 2. Anything I had to decide that wasn't specified
- **`unrated` as a boolean + kept `finalGrade="F"`**, rather than widening
  the `Grade` type to a 5th letter — explained in Fix 2 above. This was the
  main design judgment call this pass.
- **Recommendation string wording**: "Unrated - below premium floor" — you
  asked for "an explicit 'unrated / below premium floor' state," I chose
  this exact phrasing; open to a different string.
- **Fiscal-period heuristic** (Fix 1(b)): standard calendar-quarter
  buckets (Jan-Mar→Q4 prior year, Apr-Jun→Q1, Jul-Sep→Q2, Oct-Dec→Q3).
  Correct for calendar-fiscal-year companies (all 5 of these are); would
  mislabel a company with a non-calendar fiscal year. Not verified against
  each ticker's actual fiscal calendar — flagging as an assumption.
- **Commission config mechanism**: an env var (`CSP_COMMISSION_PER_CONTRACT`)
  with a code-level default, plus an optional per-call override parameter,
  rather than a new Settings-page UI + DB column. The latter would be a much
  larger change (new schema, new UI, new API route) — this felt like scope
  creep for "make it a config value," but say if you wanted the fuller
  settings-page version instead.
- **Bid/ask tooltip only for the suggested strike**, not for the
  custom-strike / editable-strike-cell overrides — explained under "not
  fixed, flagged as adjacent" in Fix 3.

## 3. Anything adjacent to the OUT OF SCOPE list, and why it was safe
- **Static rule-explanation tooltip** in the expanded row (`components/
  screener-view.tsx`, the `GradeBadge` tooltip listing "A: crush A/B · POP
  ≥ 90%...") — updated to mention the new opportunity gate on B/C. This is
  static UI documentation of the rule itself, not the per-candidate
  STRENGTH/CAUTION/BOTTOM LINE narrative text (which I left untouched) —
  the rule changed, so leaving stale documentation of the old rule felt
  like a bug I'd be introducing, not scope creep.
- **`gradeFromRulesClient`** (the client-side replica of the server rule
  cascade, explicitly commented "Keep in sync with calculateThreeLayerGrade()")
  — updated to mirror the opportunity gate + unrated flag. This wasn't
  optional: the comment already establishes these two must match, and
  leaving the client stale would make the custom-strike preview show a
  wrong grade the server would never actually return.
- **`personalModifier` boost-condition guard** (`!unrated &&`) — required
  by Fix 2 itself (without it, a good personal win-rate could silently
  promote an unrated trade to a real grade, defeating the fix), not a
  separate initiative.
- I did **not** touch crush composite scoring, sample-size weighting,
  implied-move/strike/loss-threshold formulas, the two-crush-pipeline
  merge, or VS200D/target wiring — confirmed by re-reading the diff before
  writing this report.

## 4. Anything started and backed out of
- **Restoring the spread-percentage hard-kill** — started investigating via
  git history, found the deliberate-removal rationale, stopped and asked
  before writing any code. Replaced with the narrower zero-bid kill per
  your revision — not "started and abandoned," but worth naming since it's
  the one place I changed direction mid-pass based on new information.
- **Changing `availableStrikes[].mark` to bid-pricing** — considered it (for
  consistency with the main premium fix), traced its two other call sites
  (custom-strike premium, spread% denominator in `EditableStrikeCell`),
  recognized it would need a new field rather than a value change, and
  decided against it before writing any code — flagged above as "not fixed,
  adjacent," not reverted mid-implementation.

---

`npx tsc --noEmit` and `npm run build` both clean, no new warnings, before
this report was written.
