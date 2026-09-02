# EDGAR Earnings-Date Resolution — spec for a future pass, not implemented

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

1. **Old-row pagination.** `resolveNearestEightK` only reads
   `filings.recent`. For rows old enough to have rolled off that page, this
   function returns `no_nearby_8k` indistinguishably from "no such filing
   exists" — need to decide whether to fetch the paginated
   `/submissions/CIK##########-submissions-{n}.json` files for old rows, or
   accept that this function is only effective on recent-ish rows and scope
   accordingly.
2. **What counts as a "correction" worth writing vs. noise.** An 8-K's
   `filingDate` can legitimately lag the actual earnings call by a day (a
   press release goes out, the 8-K attaching it files the next business
   day) — need a tolerance band for "close enough, don't touch `timing`
   inference" vs. "this is actually a different date," not just the raw
   `gapDays` value passed through unfiltered.
3. **`EarningsHistoryWritePath` enum migration.** Needs its own migration
   adding `'edgar-earnings-date'` (or whatever name is chosen) before any
   write — not assumed done by the existing `capture_phase` constraint
   change, which is a different enum.
4. **Re-verify the target population at build time.** The 869-vs-1,022
   discrepancy above is unresolved — re-run the `date_confidence` breakdown
   query fresh rather than trusting either number in this document by the
   time this is built.

Don't start implementation until these are resolved — they change what gets
written, not just how.
