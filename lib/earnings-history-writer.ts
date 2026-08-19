// Single writer for earnings_history's four provenance-protected
// columns: earnings_date, timing, date_confidence, data_source. Every
// production path that touches any of these must call
// writeEarningsHistory() — no other file may .upsert()/.update() them
// directly. This exists to close the gap Phase A found: 7 call sites
// had drifted onto retired data_source/date_confidence literals for
// weeks with no single choke point to catch it.
//
// Precedence is enforced in the DB (earnings_history_precedence_guard_trg,
// migrations/2026-08-19-earnings-history-precedence-trigger.sql), not
// here — this function's job is tier/path ASSIGNMENT (explicit, never
// inferred from payload shape) and REJECTION LOGGING, not re-deriving
// the precedence decision itself. See that migration file's header for
// why the trigger deploys separately, after this file's callers are
// live: landing the trigger first reproduces the 2026-08-18 outage
// (DB rejects a write no caller yet knows how to catch).
//
// tier is OPTIONAL per call, by design — most callers pre-read the row
// and only pass a tier when they intend to ASSERT one (a "date-
// authority" write: Phase 1/2C ingest, the manual editor, a repair
// script). A passive write (e.g. persistLiveImpliedMove refreshing an
// existing row's implied_move_pct) omits tier entirely, which omits
// date_confidence from the SQL payload — Postgres then leaves the
// stored value untouched, so the precedence trigger sees no tier
// change and passes trivially, exactly like today's Phase A pattern.
// dataSource is independent of tier: it's a "who last touched this
// row" stamp, not a trust level, so some paths (the manual editor)
// write it unconditionally even on a call that isn't asserting a tier.
import { createServerClient } from "./supabase";
import { quarterOfDate, quarterYearLabel } from "./quarter-label";

export type EarningsHistoryTier =
  | "human_verified"
  | "edgar_derived"
  | "vendor_derived"
  | "inferred"
  | "unknown";

export type EarningsHistoryWritePath =
  | "entry_context_stub"
  | "live_em_tracker"
  | "live_flow_snapshot"
  | "encyclopedia_phase1_finnhub"
  | "encyclopedia_phase2c_rekey"
  | "encyclopedia_live_stub"
  | "t0_capture"
  | "manual_em_editor"
  | "fetch_em_yahoo_seed"
  | "manual_repair_script"
  | "unknown_legacy_write";

export type EarningsHistoryRejection = {
  symbol: string;
  earningsDate: string;
  quarterLabel: string | null;
  attemptedBy: EarningsHistoryWritePath;
  attemptedTier: EarningsHistoryTier;
  attemptedDataSource: EarningsHistoryWritePath | null;
  attemptedTiming: string | null;
  storedTier: EarningsHistoryTier;
  storedDataSource: string;
  storedEarningsDate: string;
  storedTiming: string | null;
};

export type EarningsHistoryWriteResult =
  | { outcome: "written" }
  | { outcome: "rejected"; rejection: EarningsHistoryRejection }
  | { outcome: "error"; message: string };

type WriteKey =
  | { symbol: string; earningsDate: string; id?: undefined }
  | { id: string; symbol?: undefined; earningsDate?: undefined };

export type EarningsHistoryWrite = WriteKey & {
  // Always required — identifies the caller for rejection-log
  // attempted_by, independent of whether dataSource is written this
  // call (attemptedBy and dataSource can differ in principle; in
  // practice every current caller passes the same value for both when
  // dataSource is set).
  attemptedBy: EarningsHistoryWritePath;
  // Present => this write ASSERTS this tier (date_confidence goes into
  // the payload, subject to the precedence trigger once it's live).
  // Absent => passive write, date_confidence is left untouched.
  tier?: EarningsHistoryTier;
  // Present => data_source goes into the payload. Independent of tier.
  dataSource?: EarningsHistoryWritePath;
  // Present (including null, an explicit clear) => timing goes into
  // the payload. Absent => timing is left untouched.
  timing?: "bmo" | "amc" | "unknown" | null;
  // Rekey only (id-mode): the new earnings_date value being written.
  newEarningsDate?: string;
  // Every other (non-protected) column this call also wants to set,
  // written verbatim alongside the protected fields above.
  fields?: Record<string, unknown>;
};

function tierRank(tier: string | null): number {
  const order: EarningsHistoryTier[] = [
    "unknown",
    "inferred",
    "vendor_derived",
    "edgar_derived",
    "human_verified",
  ];
  const i = order.indexOf(tier as EarningsHistoryTier);
  return i === -1 ? -1 : i;
}

type StoredRow = {
  symbol: string;
  earnings_date: string;
  date_confidence: string;
  data_source: string;
  timing: string | null;
};

async function recordRejection(
  sb: ReturnType<typeof createServerClient>,
  opts: EarningsHistoryWrite,
  stored: StoredRow,
): Promise<EarningsHistoryRejection> {
  const rejection: EarningsHistoryRejection = {
    symbol: stored.symbol,
    earningsDate: stored.earnings_date,
    quarterLabel: quarterYearLabel(quarterOfDate(stored.earnings_date)),
    attemptedBy: opts.attemptedBy,
    attemptedTier: opts.tier ?? (stored.date_confidence as EarningsHistoryTier),
    attemptedDataSource: opts.dataSource ?? null,
    attemptedTiming: opts.timing ?? null,
    storedTier: stored.date_confidence as EarningsHistoryTier,
    storedDataSource: stored.data_source,
    storedEarningsDate: stored.earnings_date,
    storedTiming: stored.timing,
  };
  const ins = await sb.from("earnings_history_write_rejections").insert({
    symbol: rejection.symbol,
    earnings_date: rejection.earningsDate,
    quarter_label: rejection.quarterLabel,
    attempted_by: rejection.attemptedBy,
    attempted_tier: rejection.attemptedTier,
    attempted_data_source: rejection.attemptedDataSource,
    attempted_timing: rejection.attemptedTiming,
    stored_tier: rejection.storedTier,
    stored_data_source: rejection.storedDataSource,
    stored_earnings_date: rejection.storedEarningsDate,
    stored_timing: rejection.storedTiming,
  });
  if (ins.error) {
    console.warn(
      `[earnings-history-writer] rejection-log insert failed for ${rejection.symbol}@${rejection.earningsDate}: ${ins.error.message}`,
    );
  }
  return rejection;
}

export async function writeEarningsHistory(
  opts: EarningsHistoryWrite,
): Promise<EarningsHistoryWriteResult> {
  const sb = createServerClient();

  const payload: Record<string, unknown> = { ...(opts.fields ?? {}) };
  if (opts.tier !== undefined) payload.date_confidence = opts.tier;
  if (opts.dataSource !== undefined) payload.data_source = opts.dataSource;
  if (opts.timing !== undefined) payload.timing = opts.timing;
  if (opts.newEarningsDate !== undefined) payload.earnings_date = opts.newEarningsDate;

  // Postgres validates a NOT NULL constraint on the computed INSERT
  // tuple of `INSERT ... ON CONFLICT DO UPDATE` BEFORE conflict
  // detection — so an upsert omitting data_source (NOT NULL, no
  // default) fails even when the row already exists and the UPDATE
  // branch would fire. date_confidence has a DB default and is safe to
  // omit; data_source is not. A passive write (no dataSource — this
  // call can never legitimately create a row) must therefore go
  // through a real UPDATE, not an upsert, so there's no INSERT tuple
  // for Postgres to validate at all. Only a write that supplies
  // dataSource — meaning it's prepared to be the one that creates the
  // row — uses upsert.
  const res = opts.id
    ? await sb.from("earnings_history").update(payload).eq("id", opts.id)
    : opts.dataSource !== undefined
      ? await sb.from("earnings_history").upsert(
          { symbol: opts.symbol!.toUpperCase(), earnings_date: opts.earningsDate!, ...payload },
          { onConflict: "symbol,earnings_date" },
        )
      : await sb
          .from("earnings_history")
          .update(payload)
          .eq("symbol", opts.symbol!.toUpperCase())
          .eq("earnings_date", opts.earningsDate!);

  if (!res.error) return { outcome: "written" };

  if (res.error.code !== "P0001") {
    return { outcome: "error", message: res.error.message };
  }

  // Rejected by the precedence trigger — re-read the row (post-
  // rejection, so it reflects the unchanged stored state) and log a
  // full-context rejection row.
  const reread = opts.id
    ? await sb
        .from("earnings_history")
        .select("symbol,earnings_date,date_confidence,data_source,timing")
        .eq("id", opts.id)
        .maybeSingle()
    : await sb
        .from("earnings_history")
        .select("symbol,earnings_date,date_confidence,data_source,timing")
        .eq("symbol", opts.symbol!.toUpperCase())
        .eq("earnings_date", opts.earningsDate!)
        .maybeSingle();

  if (reread.error || !reread.data) {
    console.warn(
      `[earnings-history-writer] P0001 rejection but re-read failed (${opts.attemptedBy}): ${reread.error?.message ?? "row not found"}`,
    );
    return { outcome: "error", message: res.error.message };
  }

  const rejection = await recordRejection(sb, opts, reread.data as StoredRow);
  return { outcome: "rejected", rejection };
}

// Exported for the manual editor route and any other caller that wants
// to compare a candidate tier against a stored one before writing
// (e.g. to decide whether to even attempt an assertion) — not used by
// the trigger itself, which has its own independent SQL copy of this
// rank order (migrations/2026-08-19-earnings-history-precedence-trigger.sql).
export function isTierDowngrade(
  incoming: EarningsHistoryTier,
  stored: EarningsHistoryTier,
): boolean {
  return tierRank(incoming) < tierRank(stored);
}
