# Outcome Capture — spec for a future pass, not implemented

Not built this pass. Captured now, grounded in the real T0/T1 infrastructure, so it's actionable without re-discovery when the next pass starts.

## Why this is the highest-leverage next build

PASS_2A.md's headline finding: Fix B's loss-depth ladder and Fix C's calibration cap are both correctly built and both dormant — Fix B has 6 confirmed breach events system-wide, Fix C has Schwab-verified history for 1 ticker out of 60 held out. Neither is a code problem. Both are starved of the same thing: **resolved outcomes for screened CSP candidates.** One job that writes those outcomes back feeds both mechanisms simultaneously, plus gives a real prediction log for the first time (predicted grade/strike/EM vs. what actually happened).

## Precondition — blocks the build, do this first

Today `calculateBreachAnalysis` (`lib/encyclopedia.ts:381`) and the T0/T1 inline math in `captureEarningsT0`/`captureEarningsT1` compute the same breach/ratio logic **separately** — see below. Before the third cron leg is built, consolidate onto the single canonical function. If the new leg calls `calculateBreachAnalysis` while T0/T1 keep their own inline duplicate, the two paths can silently drift (a formula tweak in one place, forgotten in the other) and the resolved-outcome numbers stop meaning the same thing as the T0/T1 numbers they're supposed to reconcile against. This isn't an optional cleanup anymore — it's a dependency of the new leg being trustworthy.

## Data-integrity note — state this, don't retroactively fix it

`price_at_expiry` is currently written only as a side effect of a user clicking "Run Analysis" (`runEncyclopediaMaintenance` step 4). That means the existing backlog of populated `price_at_expiry` values is **sampled on which names someone happened to look at**, not on which names were actually screened — a real, non-random bias (users click into names they're already interested in, which skews toward names that looked promising at screen time). **Do not compute Fix B/Fix C calibration stats off this backlog.** Once the cron-driven job ships, treat its first deterministic run as the start of a clean, unbiased calibration baseline; the click-sampled history before it stays in the table for reference but shouldn't feed any statistic that assumes an unbiased sample.

## What already exists (found via a grounding pass this session — do not re-derive)

- **T0/T1 cron**: `~/Library/LaunchAgents/com.csp.crush-t0.plist` / `com.csp.crush-t1.plist`, running `~/bin/csp-crush-capture.sh {t0|t1}` weekdays (T0 12:45 PT pre-market-ish, T1 06:45 PT next morning), hitting `POST /api/earnings/capture-t0` / `capture-t1` with a `CRON_SECRET` bearer token. None of this is checked into the repo — it lives host-side.
- **`lib/earnings-capture.ts`**: `runT0Capture()` / `runT1Capture()`, the orchestration layer behind those two routes. Budget-bounded (`CAPTURE_BUDGET_MS=50_000`), idempotent, Schwab-connectivity gated.
- **`captureEarningsT0`/`captureEarningsT1`** (`lib/encyclopedia.ts`): write `price_before`/`implied_move_pct`/`iv_before`/`two_x_em_strike` (T0) and `price_after`/`iv_after`/`actual_move_pct`/`move_ratio`/`iv_crushed`/`breached_two_x_em`/`is_complete` (T1). **These compute `two_x_em_strike`/`breached_two_x_em` inline, duplicating `calculateBreachAnalysis`'s math rather than calling it** — this is the precondition above, not optional this time.
- **`calculateBreachAnalysis`** (`lib/encyclopedia.ts:381`) — the function the third leg must call, and the one T0/T1 need to be migrated onto — is currently **only** called from `updateEncyclopedia()`, a manual/admin-triggered Yahoo-price backfill (`fetch-em-history`, `encyclopedia/update`, `encyclopedia/rekey-symbol` routes). It runs on ~1.4% of rows today. Not on the T0/T1 cron path.
- **`price_at_expiry`** is written only by `ensurePriceAtExpiry()` (`lib/encyclopedia.ts:1589`), called from `runEncyclopediaMaintenance()` step 4 (`lib/encyclopedia.ts:2091`) — which itself only fires as a side effect of a user clicking "Run Analysis" in the screener UI (`analyze/pass3` and `analyze/post-actions` routes), not from the launchd cron.
- **Closest existing precedent for "N days after, revisit"**: `runEncyclopediaMaintenance` step 4's own query — `earnings_history` rows where `price_at_expiry IS NULL`, expiry computed via `nextFridayOnOrAfterIso(earnings_date)`, skipped with reason `not_yet_expired` if that date is still in the future. This is the shape to reuse; it's just not on a reliable schedule today.

## Proposed design

**A third cron leg**, not a repurposing of T1 (T1 already runs on a fixed next-morning cadence for the immediate reaction — this is a separate, later check for the fully-resolved outcome once the position would have expired). New LaunchAgent (e.g. `com.csp.crush-outcome`), new script invocation, new route `POST /api/earnings/capture-outcome`, new orchestrator `runOutcomeCapture()` in `lib/earnings-capture.ts`, following the exact `requireCronSecret` + budget-bounded + idempotent pattern T0/T1 already use.

**Trigger**: `earnings_history` rows where a weekly-or-fallback expiry can be computed from `earnings_date` (same `nextFridayOnOrAfterIso` logic already used by `ensurePriceAtExpiry`), that expiry is at least N days in the past, and `price_at_expiry IS NULL` (or a new `outcome_captured_at IS NULL`, see open question below). **N is a judgment call — propose N=1 trading day** past expiry, to guarantee Schwab's own EOD data for that date is settled rather than racing a same-day close. State it as a judgment call in the eventual implementation, not a derived constant.

**Fetch** (Schwab only): expiry-day close (reuse `ensurePriceAtExpiry`'s existing close-lookup), plus the **low** over the earnings-to-expiry window — not currently captured anywhere. The daily-bars utility already used for `realizedVol30d` (`getOrFetchDailyBars`) is the natural fetch path; extend it to also report `min(low)` over that window, since breach risk depends on the worst intraday print, not just where it settled.

**Compute — TWO separate outcomes, never merged:**

"Was the grade right" and "did I trade it well" are different questions with different denominators (every screened name vs. only the ones actually traded), and collapsing them into one column would silently answer whichever question has more data at the expense of the one the prediction log actually exists to audit. Two columns, two independent computations:

- **`theoretical_2xEM` outcome — PRIMARY.** Did the screener's own recommended strike (`two_x_em_strike`, already written by T0 for every screened candidate) hold? `breached` via `calculateBreachAnalysis` (see precondition), against expiry-day close and the window low. Always computable — this is what scores the tool itself, and what the prediction log is for. No real premium exists for a theoretical strike; use the screener's own displayed/computed premium at screen time (see the premium-sourcing question below) for a theoretical P/L, clearly labeled as such.
- **`real_position` outcome — SECONDARY, sparse.** Did the actually-logged trade in `positions` win, using its real strike/premium/exit? Only exists where the user actually traded the name. Execution quality, not grading quality — useful, but must never be blended into or substituted for the theoretical column, and should degrade gracefully to "no data" rather than falling back to the theoretical numbers when a real position doesn't exist.

`actual_move_pct` (full-period, post-earnings through expiry) is a third, separate figure from T1's immediate-reaction `actual_move_pct` — needs its own column, not an overwrite.

**Write-back**: same `earnings_history` row, upsert on `(symbol, earnings_date)` matching every other write path in this file. New value(s) tagged via a source column — **but note `implied_move_source` is the existing precedent for this exact pattern, and there's no equivalent `actual_move_source`/`outcome_source` column yet.** Adding one, defaulted/backfilled to `"schwab"` only for rows this job writes, mirrors the established convention rather than overloading the existing `data_source` column (which currently describes the EPS/calendar source, e.g. `"finnhub+calendar-rekey"` — a different concern).

**Explicitly excluded, per instruction, unchanged**: no "grade correct? (mechanism)" column, no auto-populated judgment field. That's a human call (a name can win on price and still have been graded wrong on the mechanism) — leave it blank for manual entry, whatever column ends up holding it. The third leg is a new later-resolution check, not a repurposing of T1.

## Open design questions — need resolving before implementation, not guessed at

1. **Where does premium come from for the theoretical-strike column?** `earnings_history` doesn't currently store the premium the screener showed at screen time — it lives in the `screener_results.candidates` JSON blob (a whole-batch snapshot), not per-symbol-per-event. May need a new column or a join against the nearest `screener_results` row.
2. **New column vs. reuse**: `outcome_captured_at`/`actual_move_source`/the two P/L columns — exact schema needs a migration, not assumed here.
3. **Does this run for every screened candidate, or only ones with a stored strike?** T0 already writes `two_x_em_strike` for every T0-captured row, so gating on that should cover the intended population — worth confirming there's no gap between "T0 ran" and "a real candidate was screened."

Don't start implementation until these are resolved — they change what gets written, not just how.
