# EDGAR Earnings-Date Resolution — sized 2026-09-05, declined, not implemented

**Status: declined, not "not yet built."** Sized against the live population
twice (2026-09-04 design, 2026-09-05 execution-readiness check) and found not
worth building as specified. Read this section before treating anything below
as open work.

The target population is 872 rows (`unknown` 837 + `inferred` 35 —
re-confirmed 2026-09-05, see Open Question 4's original 869-vs-1,022
discrepancy; both prior numbers were stale). Of those, only 68 lack
`actual_move_pct` at all; 67 are past-due, not just not-yet-happened. This
function, AS SPECIFIED, only touches `earnings_date`/`date_confidence` — it
deliberately leaves `timing` untouched (see "What confidence tier it would
write" below). Checked directly against `lib/encyclopedia.ts:473-497`: the
move-computation code refuses to compute a move without a real `bmo`/`amc`
timing, returning `null` rather than guess. Of the 67 move-less rows, 63 have
no usable timing (`NULL` or `'unknown'`) and would stay exactly as blocked
after this ran as before it. The other 4 are recent in-flight rows blocked by
normal capture latency, not date confidence, and would resolve on their own
regardless of this work.

**Net result: building this as specified would upgrade `date_confidence`
metadata on a majority of the 872 rows (see the CIK/8-K coverage numbers
below) but unlock zero new `actual_move_pct` values.** The real blocker for
this population is missing `timing`, not the date. See "Timing sources
investigated, none built" below for what was found instead — a materially
different, larger piece of work than this spec describes, not something this
function's scope naturally grows into.

If anyone picks this back up: re-run the population/coverage numbers again
first (they will have drifted since 2026-09-05), and decide on the timing
problem BEFORE scoping a date-only pass — a date-only pass has already been
shown to convert nothing.

---

## Original spec (2026-09-04), preserved below for context

`lib/edgar-earnings-date.ts` was built 2026-09-04 alongside the fiscal_quarter
repair (same shared client, same rate limiter) but never wired into a write
path. No spec existed for it anywhere in the repo before this file — it was
built ahead of the work that needs it, on the theory that one EDGAR
integration should share a CIK map/rate limiter instead of two drifting
apart. This is that spec, written after the fact.

## What the function does today

`resolveNearestEightK(symbol, approxDate)` (`lib/edgar-earnings-date.ts:44`)
hits `data.sec.gov/submissions/CIK##########.json`, filters to `8-K` filings,
and returns the one whose `filingDate` is closest to `approxDate` — bounded
to ±10 days (`bestAbsGap <= 10`). Returns `{filingDate, reportDate,
primaryDocument, gapDays}` or `{resolved: false, reason: "no_nearby_8k"}`.

Deliberately narrow: it **confirms/corrects a date already believed close to
correct**, not discovers an unknown one from scratch. It also only reads
`filings.recent` — the submissions API's default page, which SEC caps to the
most recent filings (not a fixed count, but old enough rows can fall off it).
A full backfill of very old rows would need the paginated
`/submissions/CIK##########-submissions-{n}.json` files, which this function
does not fetch. That's a real gap, not an oversight — see Open Questions.

Why 8-Ks and not the same `companyconcept` API `edgar-fiscal-period.ts`
uses: an 8-K's `reportDate`/`filingDate` reflect the **announcement**
(verified live during the fiscal-period repair — see that file's header
comment), which is exactly what `earnings_date` means. XBRL facts, by
contrast, carry the **fiscal period covered**, which is a different question
(`fiscal_quarter`/`fiscal_year`/`period_end`) already answered by
`edgar-fiscal-period.ts`. Do not conflate the two callers.

## Which rows this targets

The population is rows without a trustworthy `earnings_date`, i.e.
`date_confidence` below the two high-trust tiers (`human_verified`,
`edgar_derived`). As of this writing (2026-09-02):

| `date_confidence` | count |
|---|---|
| `vendor_derived` | 2,173 |
| `unknown` | 834 |
| `inferred` | 35 |
| `human_verified` | 3 |

`unknown` + `inferred` = 869 rows currently lack any derivation better than a
guess. (A prior session estimate cited ~1,022 "stub rows" for this same
population — that number does not reproduce against the live table today,
most likely because the fiscal-period repair's `manual_repair_script` writes
touched `date_confidence` on some overlapping rows as a side effect of
precedence rules on that protected column. Treat 869 as the current,
freshly-queried figure, not the earlier estimate, and re-count before
building rather than trusting either number verbatim.)

Within `unknown`, the breakdown by `data_source` (`manual_repair_script`
592, `unknown_legacy_write` 202, `encyclopedia_live_stub` 26,
`live_em_tracker` 8, `manual_em_editor` 6) shows most of today's
`unknown`-tier rows got there via the fiscal-quarter repair itself —
`writeEarningsHistory` writes with `dataSource: 'manual_repair_script'` only
overwrote `data_source` where precedence allowed it, and evidently downgraded
some rows' apparent tier in the process. This function's target population
and the fiscal-period repair's population overlap but are not identical —
confirm the intersection before assuming this closes the same backlog.

`vendor_derived` (2,173 rows) is explicitly **out of scope** for this
function — those already have a Finnhub/Yahoo-sourced date with reasonable
trust; re-deriving from EDGAR for all 2,173 would be a much larger SEC
API load for a marginal trust upgrade, not what this was built for.

## What confidence tier it would write

`edgar_derived` — already reserved in the `date_confidence` check constraint
(`migrations/2026-08-18-earnings-history-date-provenance.sql:110`) since the
Aug 18 migration, unused until now. Ranks below `human_verified` and above
`vendor_derived`/`inferred`/`unknown` in that migration's trust ordering.

Any write must go through `writeEarningsHistory` (`lib/earnings-history-writer.ts`)
— the sole writer for the four protected columns (`earnings_date`, `timing`,
`date_confidence`, `data_source`) — with `dataSource` set to a new,
not-yet-added `EarningsHistoryWritePath` value (e.g. `'edgar-earnings-date'`;
note `earnings_capture_attempts.capture_phase` already accepts this string
per the 2026-09-04 migration, but the separate `EarningsHistoryWritePath`
enum governing `data_source`/`dataSource` does not yet — that enum needs its
own migration before any write, matching how `'manual_repair_script'` was
already a reserved value before the fiscal-period repair used it).

`timing` (pre/post-market) is not derivable from an 8-K's `filingDate` alone
— 8-Ks don't carry a time-of-day field in the submissions API's `recent`
block. Leave `timing` untouched unless a separate signal for it is added;
writing `date_confidence: 'edgar_derived'` without also claiming `timing`
confidence it doesn't have would misrepresent what was actually verified.

## Proposed design

A new sweep, same shape as `eps-sweep.ts`'s branch structure: iterate
target rows, call `resolveNearestEightK(symbol, row.earnings_date)`, and
where `resolved: true` and the returned `reportDate` (or `filingDate`)
**differs** from the stored `earnings_date`, write the correction with
`date_confidence: 'edgar_derived'`. Where it **matches** the stored date,
still write `date_confidence: 'edgar_derived'` (upgrading trust without
changing the value) — the confirmation itself has value even when nothing
changes, exactly as `date_confidence` is meant to capture "how sure are we,"
not just "did we change something."

Log every attempt via `recordEdgarAttempt` (`lib/edgar-client.ts:94`,
`phase: 'edgar-earnings-date'`) — already wired for this, unused until a
caller exists. This is also the retry-throttle substrate: reuse the same
`RETRY_THROTTLE_DAYS`-via-`earnings_capture_attempts` pattern `eps-sweep.ts`
uses for its backlog branch (`lib/eps-sweep.ts:41-55`), so a `no_nearby_8k`
row doesn't get re-hit against SEC on every run.

## Open design questions — need resolving before implementation, not guessed at

1. **Old-row pagination — RESOLVED 2026-09-05, smaller than feared.** Tested
   `resolveNearestEightK` live against a stratified sample (all 29 rows from
   2024, plus 60 random from 2025 and 20 from 2026 — 109 total, real SEC
   calls, not simulated). `no_nearby_8k` (the actual pagination-wall failure)
   hit only 10/109 (~9%), including just 3/29 (~10%) among the oldest 2024
   rows. The dominant failure was `cik_not_found` (22/109, ~20%) — see #4
   below, a different problem with its own fix. Paginating the older
   `/submissions/CIK##########-submissions-{n}.json` files is not worth
   building for this population; the "recent" page already covers it.
2. **What counts as a "correction" worth writing vs. noise.** Still open —
   moot now given the decision to decline, but if revisited: an 8-K's
   `filingDate` can legitimately lag the actual earnings call by a day (a
   press release goes out, the 8-K attaching it files the next business
   day) — need a tolerance band for "close enough, don't touch `timing`
   inference" vs. "this is actually a different date," not just the raw
   `gapDays` value passed through unfiltered.
3. **`EarningsHistoryWritePath` enum migration.** Still open — moot now
   given the decision to decline. Needs its own migration adding
   `'edgar-earnings-date'` (or whatever name is chosen) before any write —
   not assumed done by the existing `capture_phase` constraint change, which
   is a different enum.
4. **Re-verify the target population at build time — RESOLVED 2026-09-05.**
   872 rows (`unknown` 837 + `inferred` 35), re-confirmed live. Neither 869
   nor 1,022 was current by the time this was actually sized; re-count again
   if this is ever revisited, the number will have drifted further.
5. **CIK resolution — fixed 2026-09-05, independently of the decision to
   decline the rest of this work.** `resolveCik` (`lib/edgar-client.ts`) only
   checked `company_tickers.json`, which excludes tickers that have since
   been acquired/merged/delisted even though SEC still has their full CIK
   and filing history. Ported the same browse-edgar fallback already added
   to `lib/sec-edgar.ts`'s `getCIK` — see that file's `getCIKForDelistedTicker`
   comment for the mechanism. Tested against the 527 distinct symbols in
   this population: 512/527 resolved before the fix, 526/527 after. This fix
   shipped (it's cheap and correct on its own) even though the date resolver
   itself did not.

Implementation is declined — see the top of this document. These open
questions are preserved for whoever reopens this, not because anyone should
act on them now.

## Timing sources investigated 2026-09-05, none built

The real blocker for this population turned out to be `timing`, not
`earnings_date` (see the top of this document). Three candidate sources for
filling `timing` were sized, read-only, before concluding none should be
built as part of reviving this spec:

- **Finnhub's calendar `hour` field** (`timing_source='finnhub_hour'`,
  `lib/encyclopedia.ts:2649-2665`) — **~0% coverage for backfill.** Finnhub's
  free-tier `/calendar/earnings` is forward-only (`lib/encyclopedia.ts:1065-1077`,
  `lib/yahoo.ts:684-685`); it can supply timing for new events going forward,
  never for the 812 rows already stuck. Never independently audited for
  correctness either.
- **Yahoo's timestamp heuristic** (`timing_source='yahoo_timestamp_heuristic'`,
  `lib/encyclopedia.ts:1078-1168`) — **~0.4% actionable, and already excluded
  from this population by design.** A real prior run
  (`backfill-earnings-timing-report.json`) found 757/1,011 candidates had no
  Yahoo calendar entry, 249 were unverifiable against stored prices, and only
  4 were cleanly written. A confirmed-wrong case exists (RVTY: heuristic said
  BMO, real price action showed AMC). `scripts/backfill-earnings-timing.ts`
  already refuses to run against `inferred`/`unknown`-tier rows — "deriving
  timing against a date we don't trust would be building on sand" — so this
  source was already ruled out for exactly this population before this sizing
  pass even started.
- **8-K `acceptanceDateTime` as a BMO/AMC proxy — real reach, validated
  against ground truth 2026-09-05, not reliable enough to build.** This spec
  previously stated (a few paragraphs above) that "8-Ks don't carry a
  time-of-day field in the submissions API's `recent` block" — **that claim
  is wrong**, confirmed by fetching the live API. `acceptanceDateTime` is
  present in the exact same `filings.recent` block `resolveNearestEightK`
  already parses, at zero extra request cost. Across the 812-row population:
  736/812 (91%) find a nearby 8-K, and 536/812 (66%) classify as
  unambiguous BMO/AMC via a plain ET-hour cutoff ("clean" — 342 BMO, 194 AMC).
  The remaining 276 split into 184 boundary (9:00-9:45 or 16:00-16:15 ET), 16
  intraday (accepted during market hours — not the earnings 8-K), 70 with no
  nearby 8-K, and 6 with no CIK.

  **An earlier 35-row spot-check reported 34/35 (97%) "classified
  unambiguously" — that number measured the wrong thing.** It checked
  whether the ET-hour cutoff produced a confident bucket (clean vs.
  ambiguous), not whether the bucket was correct. It is not a validation and
  should not have been read as one.

  The real validation, run against the 136 rows where `timing_source='manual'`
  — timing hand-corrected via actual price-path divergence review,
  independent of any 8-K data — found **79/99 (80%) agreement** on the rows
  that landed in a "clean" bucket. The 20 disagreements are not scattered
  noise; they split into two systematic, per-company failure modes:
    - 13 cases: 8-K accepted 6:00-8:20am ET, real timing was AMC (the
      release happened the evening before; the company doesn't file the
      formal 8-K until the next pre-market morning). TER shows this on all 4
      of its instances in the sample — a filing habit, not noise.
    - 7 cases (NTAP, DUK, CTVA, LDOS, FRT, TYL, UDR): 8-K accepted
      4:20-5:47pm ET, real timing was BMO (same-day early release, 8-K not
      filed until end of business that evening).

  These sit interleaved minute-by-minute with correctly-classified rows in
  the identical time band (e.g. LDOS's wrong-BMO case at 17.71 ET sits
  between two correctly-classified AMC rows at 17.64 and 17.74) — no
  threshold retuning separates them, because the deciding factor is a given
  company's filing-lag convention, not time of day. Applying this ~20% error
  rate to the 536 "clean" rows in the 812-row population means roughly
  **107 of them would silently compute the wrong close pair** — with nothing
  in the data flagging which ones. That is the exact "plausible-looking
  wrong number, worse than null" failure this document already worried about
  for `earnings_date` itself, now confirmed for `timing`.

Not built because: the validated accuracy (80% on the reachable subset) isn't
close to good enough given a wrong call is worse than a gap, and even a
reliable version of this would be a materially different, larger piece of
work than the date-only pass this spec describes (a new `timing_source`
value, a same-day-only trust gate, and — per "What confidence tier it would
write" above — the existing design already deliberately avoids claiming
`timing` confidence alongside `date_confidence` upgrades, which would need
to change). If this is worth building, size it as its own thing with its own
spec, not as a natural extension of this one.

**A possible future path, explicitly not proposed:** the errors above are
per-company (TER always lags a day; NTAP/DUK/CTVA/FRT/LDOS/TYL/UDR always
file late-same-day), the same shape as the `finnhub_fiscal_label_calibration`
table built 2026-09-04 for the fiscal-label shift problem. A per-symbol
filing-lag calibration could in principle correct most of this. It isn't
proposed here because it would need per-symbol ground truth to calibrate
against — confirmed-correct timing for multiple instances of the same
symbol — and that is exactly what's scarce in this population (136 rows
total, most symbols appearing once or twice). Noted so it isn't
rediscovered as an untried idea; it was considered and set aside for lack of
calibration material, not overlooked.
