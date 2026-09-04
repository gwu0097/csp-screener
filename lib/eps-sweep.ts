// Scheduled eps_surprise_pct backfill sweep.
//
// eps_surprise_pct is currently written only inside updateEncyclopedia,
// which ALSO calls Yahoo price-action and fetchImpliedMove (a second,
// uncoordinated Schwab path outside the T0/T1 budget/guard discipline).
// Triggering that whole function on a schedule would duplicate the
// em-universe-seed job's Schwab-capture responsibility and add an
// unbudgeted Schwab call. This sweep instead calls fetchFinnhubEarnings
// directly (Finnhub-only, already rate-paced internally via
// FINNHUB_RATE_DELAY_MS) and writes only eps_estimate/eps_actual/
// eps_surprise_pct via the same pctChange() formula updateEncyclopedia
// uses — same computation, narrower trigger.
//
// No pre-print timing constraint (backward-looking, Finnhub-sourced) —
// this can run any time after the print. It deliberately DOES wait a
// short while after: see SETTLING_DELAY_DAYS below — Finnhub's own
// quarter/year labels for a just-reported quarter aren't reliable in the
// first few days, so capturing too early doesn't just risk no data, it
// risks confidently-wrong data.
//
// Row selection is two branches, not one (2026-09-04 retry fix):
//   1. Recent (earnings_date within T1_RETRY_CUTOFF_DAYS) — the
//      original T0/T1-adjacent "catch it soon after the print" case.
//   2. Backlog (earnings_date older than that) — rows whose
//      fiscal_quarter was null at the time they aged out of branch 1,
//      then got backfilled later by the EDGAR fiscal-period resolver.
//      Bounding branch 2 by earnings_date the same way branch 1 is
//      would defeat its own purpose: a 10-Q/10-K can land well past 10
//      days after earnings_date (up to the 40/45-day statutory
//      deadline), so by the time fiscal_quarter is actually known, the
//      row has long since aged out of any earnings_date-bound query.
//      Without branch 2, EVERY quarter's freshest rows pass through the
//      exact same unprotected window this repair just closed, and the
//      backlog rebuilds itself. Branch 2 is instead throttled by
//      RETRY_THROTTLE_DAYS — how long since eps-sweep itself last
//      looked at this specific row — via earnings_capture_attempts,
//      not by how old the row is. See RETRY_THROTTLE_DAYS below for why
//      7, not the 45-60 days that bounds the EDGAR resolver itself.
import { fetchFinnhubEarningsResult, pctChange } from "./encyclopedia";
import { recordAncillaryAttempt, T1_RETRY_CUTOFF_DAYS } from "./earnings-capture-attempts";
import { createServerClient } from "./supabase";

const SWEEP_BUDGET_MS = 50_000;

// Throttles branch 2 (backlog) retries — distinct from, and much
// shorter than, the ~45-60 day window that bounds the EDGAR
// fiscal-period resolver itself (that one is bounded by the SEC 10-Q
// filing deadline: how long fiscal_quarter can plausibly take to
// become knowable at all). This one is a pure efficiency throttle: once
// fiscal_quarter DOES land, matching against Finnhub is a cheap,
// deterministic lookup, so there's no reason for a row to wait a month
// to be picked up. 7 days keeps a stuck row from being re-queried
// against Finnhub daily forever (wasteful once "still no match" is
// established), while still closing the loop within about a week of
// fiscal_quarter actually landing — a full order of magnitude tighter
// than the resolver's own give-up horizon, because retrying a resolved
// case is cheap and re-attempting an unresolved one gains nothing by
// waiting longer than this.
const RETRY_THROTTLE_DAYS = 7;

// Skip capturing EPS within this many days of earnings_date at all —
// added 2026-09-02 after an audit found Finnhub's own quarter/year labels
// for a just-reported quarter are not yet stable that early: of 28
// verifiable rows whose ONLY-EVER capture attempt landed within 3 days of
// earnings_date, 25 (89%) held the WRONG quarter's actual (confirmed live
// against current Finnhub data — OKTA was the first found, e.g., but far
// from the only one). A stratified re-check of rows captured later showed
// 29/29 agreement at 6+ days, with the sole disagreement at 4 days
// (HIMS) tracing to Finnhub revising its own published actual after the
// fact — a different problem a settling delay can't fix, and rare enough
// (1 case) not to justify pushing N further out on this evidence alone.
// 7, not a new number, deliberately reuses RETRY_THROTTLE_DAYS's value: a
// row skipped here for being too fresh falls straight into the same
// backlog-retry path that already re-attempts every RETRY_THROTTLE_DAYS,
// rather than needing a second, independently-tuned cutoff.
const SETTLING_DELAY_DAYS = 7;

// Caps how many branch-3 (verify) rows one sweep run will attempt.
// Finnhub's plan limit is 60 requests per rolling window (confirmed live
// 2026-09-03 via the x-ratelimit-limit response header), shared across
// EVERY Finnhub-dependent feature on this app, not just this sweep — a
// 708-row backlog processed in one request blew straight through it and
// the run silently logged ~700 rows as "no Finnhub data" when the real
// cause was 429s. This isn't a pacing problem a shorter per-call delay
// can fix inside one 60s serverless invocation (708 rows at even a
// perfect 60/min pace is ~12 minutes); it's a batch-size problem. Capped
// low enough to leave real headroom for T0/T1 and everything else
// sharing the same key, so the backlog drains in batches over the
// existing daily cron cadence instead of racing other features for
// quota once a day.
const VERIFY_BATCH_SIZE = 40;

// One-time priority ordering for the 25 rows the 2026-09-02 early-capture
// audit directly confirmed wrong against live Finnhub data (OKTA plus 24
// others captured within 3 days of earnings_date, before Finnhub's own
// labels had settled) — see EDGAR_EARNINGS_DATE_SPEC.md's companion
// follow-up for the full list and methodology. The rest of the 713-row
// verify backlog is unverified, not confirmed wrong, so these go first.
// Self-cleaning: once a row here is re-verified, it drops out of the
// verify candidate pool entirely (last_verified_at gets stamped), so
// this set naturally becomes inert without needing removal.
const PRIORITY_VERIFY_ROWS = new Set([
  "OKTA|2026-08-26",
  "ADSK|2026-08-27",
  "AMAT|2026-08-13",
  "CBRS|2026-08-12",
  "CRWD|2026-08-26",
  "DE|2026-08-20",
  "FIGR|2026-08-13",
  "GTLB|2026-09-01",
  "HRL|2026-08-27",
  "KEYS|2026-08-18",
  "LGN|2026-08-13",
  "NDSN|2026-08-19",
  "NTAP|2026-09-02",
  "NVDA|2026-08-26",
  "RBRK|2026-08-27",
  "TJX|2026-08-19",
  "TOL|2026-08-18",
  "VEEV|2026-08-26",
  "WMT|2026-08-20",
  "BOX|2026-08-25",
  "HD|2026-08-18",
  "LOW|2026-08-19",
  "TGT|2026-08-19",
  "ULTA|2026-08-27",
  "WSM|2026-08-25",
]);

// Finnhub free-tier /stock/earnings returns the 4 most recent quarters
// regardless of the requested window — a wide window here just ensures
// the requested range doesn't itself exclude the row client-side.
const FINNHUB_LOOKBACK_DAYS = 730;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Candidate = {
  id: string;
  symbol: string;
  earnings_date: string;
  fiscal_quarter: number | null;
  fiscal_year: number | null;
  period_end: string | null;
};

export type EpsSweepReport = {
  ok: boolean;
  dryRun: boolean;
  candidates: number;
  captured: Array<{ symbol: string; earnings_date: string; eps_surprise_pct: number | null }>;
  skipped: Array<{ symbol: string; earnings_date: string; reason: string }>;
  errors: Array<{ symbol: string; earnings_date: string; reason: string }>;
  budget_exhausted: boolean;
};

export async function runEpsSweep(opts?: { dryRun?: boolean }): Promise<EpsSweepReport> {
  const dryRun = opts?.dryRun === true;
  const startedAt = Date.now();
  const today = todayIso();
  const windowStart = addDaysIso(today, -T1_RETRY_CUTOFF_DAYS);

  const report: EpsSweepReport = {
    ok: true,
    dryRun,
    candidates: 0,
    captured: [],
    skipped: [],
    errors: [],
    budget_exhausted: false,
  };

  const sb = createServerClient();
  const cols = "id,symbol,earnings_date,fiscal_quarter,fiscal_year,period_end,eps_surprise_pct,implied_move_source";

  // Branch 1: recent, as before.
  const recentRes = await sb
    .from("earnings_history")
    .select(cols)
    .gte("earnings_date", windowStart)
    .lte("earnings_date", today)
    .is("eps_surprise_pct", null);
  if (recentRes.error) {
    report.ok = false;
    report.errors.push({ symbol: "", earnings_date: "", reason: `query failed: ${recentRes.error.message}` });
    return report;
  }

  // Branch 2: backlog — earnings_date older than the recent window,
  // eps_surprise_pct still null. Not bounded by earnings_date at all;
  // Finnhub's own data availability (via the exact-match logic below)
  // is the natural limiter on whether a match can succeed, and
  // RETRY_THROTTLE_DAYS below is the limiter on how often a given row
  // gets re-attempted.
  const backlogRes = await sb
    .from("earnings_history")
    .select(cols)
    .lt("earnings_date", windowStart)
    .is("eps_surprise_pct", null);
  if (backlogRes.error) {
    report.ok = false;
    report.errors.push({ symbol: "", earnings_date: "", reason: `backlog query failed: ${backlogRes.error.message}` });
    return report;
  }
  type RawRow = Candidate & { implied_move_source: string | null };
  const backlogCandidates = (backlogRes.data ?? []) as RawRow[];

  let backlogRows: RawRow[] = [];
  if (backlogCandidates.length > 0) {
    const throttleCutoff = new Date(Date.now() - RETRY_THROTTLE_DAYS * 86_400_000).toISOString();
    const attemptsRes = await sb
      .from("earnings_capture_attempts")
      .select("earnings_history_id")
      .in("earnings_history_id", backlogCandidates.map((r) => r.id))
      .eq("capture_phase", "eps-sweep")
      .gte("attempted_at", throttleCutoff);
    const recentlyAttempted = new Set(
      ((attemptsRes.data ?? []) as Array<{ earnings_history_id: string }>).map((a) => a.earnings_history_id),
    );
    backlogRows = backlogCandidates.filter((r) => !recentlyAttempted.has(r.id));
  }

  // Branch 3: verify — rows the EDGAR fiscal-period resolver actually
  // corrected (a logged edgar-fiscal-period "resolved" attempt), not
  // "any row with fiscal_quarter set." Most rows with fiscal_quarter
  // already came from ordinary ingestion, long before that resolver
  // existed, and were never touched by it — re-verifying all of those
  // would be a much larger, unrelated job (confirmed live 2026-09-02:
  // ~2,675 rows have fiscal_quarter set vs. 713 the resolver actually
  // corrected). Unlike branches 1/2, this is NOT gated on
  // eps_surprise_pct at all — the whole point is to reach rows that
  // already hold a value, right or wrong, written before fiscal_quarter
  // was corrected. eps_surprise_pct IS NULL can never see those again
  // once any value lands there (confirmed live: 518 of the 713 corrected
  // rows have zero eps-sweep attempts logged, frozen on pre-correction
  // data indefinitely — see last_verified_at's column comment). The real
  // gate here is last_verified_at: never verified under this regime, or
  // verified before this row's own fiscal-period correction landed (the
  // second case has zero matches today since the column is new, but
  // matters the next time a row's fiscal_quarter is corrected after an
  // earlier verification).
  type VerifyRow = RawRow & { last_verified_at: string | null };
  const resolvedAtById = new Map<string, string>();
  {
    let cursor = "";
    while (true) {
      let q = sb
        .from("earnings_capture_attempts")
        .select("earnings_history_id,attempted_at")
        .eq("capture_phase", "edgar-fiscal-period")
        .eq("outcome", "resolved")
        .order("earnings_history_id", { ascending: true })
        .limit(500);
      if (cursor) q = q.gt("earnings_history_id", cursor);
      const res = await q;
      if (res.error) break;
      const page = (res.data ?? []) as Array<{ earnings_history_id: string; attempted_at: string }>;
      for (const a of page) {
        const prev = resolvedAtById.get(a.earnings_history_id);
        if (!prev || a.attempted_at > prev) resolvedAtById.set(a.earnings_history_id, a.attempted_at);
      }
      if (page.length < 500) break;
      cursor = page[page.length - 1].earnings_history_id;
    }
  }
  let verifyRows: RawRow[] = [];
  if (resolvedAtById.size > 0) {
    const resolvedIds = Array.from(resolvedAtById.keys());
    const verifyCols = cols + ",last_verified_at";
    const fetched: VerifyRow[] = [];
    const CHUNK = 200;
    for (let i = 0; i < resolvedIds.length; i += CHUNK) {
      const chunk = resolvedIds.slice(i, i + CHUNK);
      const res = await sb.from("earnings_history").select(verifyCols).in("id", chunk);
      if (!res.error) fetched.push(...((res.data ?? []) as VerifyRow[]));
    }
    const isPriority = (r: RawRow) => PRIORITY_VERIFY_ROWS.has(`${r.symbol.toUpperCase()}|${r.earnings_date}`);
    verifyRows = fetched
      .filter((r) => {
        const resolvedAt = resolvedAtById.get(r.id);
        if (!resolvedAt) return false;
        return r.last_verified_at === null || r.last_verified_at < resolvedAt;
      })
      // Priority rows first (see PRIORITY_VERIFY_ROWS), then oldest
      // earnings_date so the rest of the backlog drains in a stable,
      // predictable order across runs instead of an arbitrary subset
      // each day (fetch order isn't guaranteed stable across the
      // chunked .in() calls above).
      .sort((a, b) => {
        const pa = isPriority(a) ? 0 : 1;
        const pb = isPriority(b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.earnings_date < b.earnings_date ? -1 : a.earnings_date > b.earnings_date ? 1 : 0;
      })
      .slice(0, VERIFY_BATCH_SIZE);
  }

  const seenIds = new Set<string>();
  const rows: RawRow[] = [];
  for (const r of [...((recentRes.data ?? []) as RawRow[]), ...backlogRows, ...verifyRows]) {
    // Manual-row guard: 'manual' means "hands off this row from any
    // automated writer" everywhere else in this pipeline (T0/T1 both
    // skip the whole row, not just the implied-move field) — same rule
    // applied here for consistency, not just for the EM field.
    if (r.implied_move_source === "manual") continue;
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    rows.push(r);
  }
  report.candidates = rows.length;

  for (const row of rows) {
    if (Date.now() - startedAt > SWEEP_BUDGET_MS) {
      report.budget_exhausted = true;
      break;
    }
    const symbol = row.symbol.toUpperCase();
    const daysSincePrint = Math.round(
      (Date.parse(today + "T00:00:00Z") - Date.parse(row.earnings_date + "T00:00:00Z")) / 86_400_000,
    );
    if (daysSincePrint < SETTLING_DELAY_DAYS) {
      report.skipped.push({ symbol, earnings_date: row.earnings_date, reason: "too_recent_settling_delay" });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: row.id,
          symbol,
          earningsDate: row.earnings_date,
          phase: "eps-sweep",
          outcome: "too_recent_settling_delay",
        }).catch(() => {});
      }
      continue;
    }
    try {
      // to=today (not a future bound) silently dropped exactly the
      // candidates this sweep exists to find — confirmed live
      // (2026-09-04): fetchFinnhubEarnings's own `period <= to` filter
      // discarded CRM's correct Finnhub row because Finnhub's period
      // label for it (2026-09-30) sits after "today" even though the
      // real quarter was reported weeks earlier. Finnhub's period label
      // is not a reliable date — that's the whole reason this sweep now
      // matches by fiscal_quarter+fiscal_year instead of by date at
      // all. A generous future bound here costs nothing: the exact-
      // match logic below is what actually gates correctness, not this
      // window.
      const finnhubResult = await fetchFinnhubEarningsResult(
        symbol,
        addDaysIso(today, -FINNHUB_LOOKBACK_DAYS),
        addDaysIso(today, 120),
      );

      if (finnhubResult.status === "rate_limited") {
        // Circuit breaker, not a per-row skip: every remaining candidate
        // this run would hit the same 429 (the limit is account-wide,
        // shared with T0/T1/screener/everything else on this key) —
        // continuing would just burn the rest of the run logging
        // identical failures. Stop now; nothing here was verified, so
        // last_verified_at is untouched and every unprocessed row is
        // eligible again on the next run.
        report.skipped.push({ symbol, earnings_date: row.earnings_date, reason: "finnhub_rate_limited" });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: "finnhub_rate_limited",
          }).catch(() => {});
        }
        report.budget_exhausted = true;
        break;
      }
      if (
        finnhubResult.status === "network_error" ||
        finnhubResult.status === "malformed" ||
        finnhubResult.status === "http_error"
      ) {
        // Distinct from finnhub_empty: this is a failed check, not a
        // completed one that found nothing. Goes to report.errors (not
        // skipped) so it's visible, and does NOT stamp last_verified_at —
        // retry on a later run rather than treating this as verified.
        const message =
          finnhubResult.status === "http_error"
            ? `finnhub_${finnhubResult.status}_${finnhubResult.httpStatus}: ${finnhubResult.message}`
            : `finnhub_${finnhubResult.status}: ${finnhubResult.message}`;
        report.errors.push({ symbol, earnings_date: row.earnings_date, reason: message });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: finnhubResult.status,
            errorMessage: message,
          }).catch(() => {});
        }
        continue;
      }
      if (finnhubResult.status === "empty") {
        report.skipped.push({ symbol, earnings_date: row.earnings_date, reason: "finnhub_empty" });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: "finnhub_empty",
          }).catch(() => {});
        }
        continue;
      }

      // Finnhub rows are keyed by fiscal period (quarter-end), this row
      // by announcement date — match ONLY on fiscal identifiers already
      // stamped on the row: fiscal_quarter+fiscal_year first, else an
      // exact period_end match. No proximity/date-based fallback.
      //
      // A "nearest preceding period <= earnings_date" fallback lived
      // here until a 2026-09-04 audit found it silently writing the
      // WRONG quarter's actual onto the row: Finnhub's own period label
      // for the correct just-reported quarter frequently falls AFTER
      // earnings_date (confirmed for CRM, DELL, MRVL, MDB — a 4-for-4
      // reproduction, not an edge case), so "preceding" reliably grabbed
      // the PRIOR quarter instead. On RKLB it went further: the estimate
      // matched the right quarter while the actual silently landed from
      // a different, older one on the same row — flipping the sign of
      // the surprise (stored: +60.8% beat; real: a miss). A wrong number
      // reads as real data and poisons every downstream read; a null
      // one is visibly incomplete and self-heals once fiscal_quarter is
      // backfilled (see the accompanying repair plan). When neither
      // identifier resolves, skip and log why rather than guess.
      const finnhubRows = finnhubResult.rows;
      let match: (typeof finnhubRows)[number] | null = null;
      if (row.fiscal_quarter !== null && row.fiscal_year !== null) {
        match =
          finnhubRows.find((r) => r.quarter === row.fiscal_quarter && r.year === row.fiscal_year) ??
          null;
      }
      if (!match && row.period_end !== null) {
        match = finnhubRows.find((r) => r.period === row.period_end) ?? null;
      }

      if (!match) {
        let reason: "no_fiscal_identifiers" | "out_of_window" | "unmatched";
        if (row.fiscal_quarter === null && row.period_end === null) {
          reason = "no_fiscal_identifiers";
        } else {
          // "no_period_match" used to cover both of these, but they're
          // opposite findings: a row whose target period predates
          // everything Finnhub returned is a SOURCE LIMITATION (Finnhub's
          // /stock/earnings returns ~4 most recent quarters regardless of
          // the requested window — an old row's quarter is simply never
          // in there, and retrying gains nothing since that window is
          // always anchored to now, not to the row's own period). A row
          // whose target period falls WITHIN Finnhub's returned range but
          // still didn't match is a real DISAGREEMENT worth investigating
          // — our stamped fiscal identifiers may be wrong, or Finnhub's
          // own labeling is inconsistent for this row. finnhubRows is
          // guaranteed non-empty here (the "empty" status returned
          // earlier). See migrations/2026-09-04-split-no-period-match.sql.
          const targetPeriod = row.period_end ?? row.earnings_date;
          const oldestFinnhubPeriod = finnhubRows.reduce(
            (min, r) => (r.period < min ? r.period : min),
            finnhubRows[0].period,
          );
          reason = targetPeriod < oldestFinnhubPeriod ? "out_of_window" : "unmatched";
        }
        report.skipped.push({ symbol, earnings_date: row.earnings_date, reason });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: reason,
          }).catch(() => {});
          // out_of_window and unmatched both mean Finnhub DID respond and
          // we DID check this row's fiscal identifiers against it — a
          // completed verification either way, just with different
          // implications. Stamp last_verified_at + last_verified_status so
          // branch 3 doesn't re-check it on every run until fiscal_quarter
          // changes again. no_fiscal_identifiers gets neither: there was
          // nothing to check yet, not a completed verification.
          if (reason !== "no_fiscal_identifiers") {
            const upd = await sb
              .from("earnings_history")
              .update({ last_verified_at: new Date().toISOString(), last_verified_status: reason })
              .eq("id", row.id);
            if (upd.error) throw new Error(upd.error.message);
          }
        }
        continue;
      }

      const eps_surprise_pct = pctChange(match.actual, match.estimate);
      if (!dryRun) {
        const upd = await sb
          .from("earnings_history")
          .update({
            eps_estimate: match.estimate,
            eps_actual: match.actual,
            eps_surprise_pct,
            last_verified_at: new Date().toISOString(),
            last_verified_status: "captured",
          })
          .eq("id", row.id);
        if (upd.error) throw new Error(upd.error.message);
      }
      report.captured.push({ symbol, earnings_date: row.earnings_date, eps_surprise_pct });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: row.id,
          symbol,
          earningsDate: row.earnings_date,
          phase: "eps-sweep",
          outcome: "captured",
        }).catch(() => {});
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.errors.push({ symbol, earnings_date: row.earnings_date, reason: message });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: row.id,
          symbol,
          earningsDate: row.earnings_date,
          phase: "eps-sweep",
          outcome: "error",
          errorMessage: message,
        }).catch(() => {});
      }
    }
  }

  return report;
}
