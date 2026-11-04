// DB access for the Robinhood earnings calendar
// (migrations/2026-11-04-robinhood-earnings-calendar.sql). Written by
// app/api/robinhood-calendar/ingest, read by Screen Today.
import { createServerClient } from "@/lib/supabase";
import { addDaysIso, type RhCalendarRow, type RhTiming } from "@/lib/robinhood-calendar-validate";

export type RhBatchMeta = {
  id: string;
  fetchedAt: string;
  windowStart: string;
  windowEnd: string;
  rowCount: number;
};
export type RhBatch = RhBatchMeta & { rows: RhCalendarRow[] };

export type LoadedRhBatch =
  | { status: "ok"; batch: RhBatch }
  | { status: "missing" }
  | { status: "error"; message: string; fetchedAt: string | null };

export const RH_BATCH_RETENTION_DAYS = 30;
// PostgREST's server-side max-rows (~1000, see lib/supabase.ts notes):
// a read returning this many rows may have been cut short, so it is
// treated as a failed read rather than a complete one.
const READ_CAP = 1000;
const INSERT_CHUNK = 500;

type BatchRow = { id: string; fetched_at: string; window_start: string; window_end: string; row_count: number };

function toMeta(r: BatchRow): RhBatchMeta {
  return { id: r.id, fetchedAt: r.fetched_at, windowStart: r.window_start, windowEnd: r.window_end, rowCount: r.row_count };
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 40; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

export async function getLatestRhBatchMeta(): Promise<RhBatchMeta | null> {
  const sb = createServerClient();
  const res = await sb
    .from("robinhood_earnings_batches")
    .select("id,fetched_at,window_start,window_end,row_count")
    .order("fetched_at", { ascending: false })
    .limit(1);
  if (res.error) throw new Error(`robinhood_earnings_batches read failed: ${res.error.message}`);
  const row = ((res.data ?? []) as BatchRow[])[0];
  return row ? toMeta(row) : null;
}

/** Rows of one batch on report dates [start, end]. One read per date so
 * no single read nears the row cap (busiest real day: 323 rows). */
export async function readRhBatchRows(batchId: string, start: string, end: string): Promise<RhCalendarRow[]> {
  const sb = createServerClient();
  const rows: RhCalendarRow[] = [];
  for (const date of datesBetween(start, end)) {
    const res = await sb
      .from("robinhood_earnings_rows")
      .select("symbol,report_date,timing,verified")
      .eq("batch_id", batchId)
      .eq("report_date", date)
      .limit(READ_CAP);
    if (res.error) throw new Error(`robinhood_earnings_rows read failed: ${res.error.message}`);
    const data = (res.data ?? []) as Array<{ symbol: string; report_date: string; timing: RhTiming; verified: boolean }>;
    if (data.length >= READ_CAP) throw new Error(`robinhood_earnings_rows read for ${date} hit the ${READ_CAP}-row cap`);
    for (const r of data) rows.push({ symbol: r.symbol, reportDate: r.report_date, timing: r.timing, verified: r.verified });
  }
  return rows;
}

/** The newest batch with all its rows. A row count that doesn't match
 * the batch header (partial write, truncated read) is an error, never a
 * silently partial calendar. */
export async function loadLatestRhBatch(): Promise<LoadedRhBatch> {
  let meta: RhBatchMeta | null = null;
  try {
    meta = await getLatestRhBatchMeta();
    if (!meta) return { status: "missing" };
    const rows = await readRhBatchRows(meta.id, meta.windowStart, meta.windowEnd);
    if (rows.length !== meta.rowCount) {
      return {
        status: "error",
        message: `batch ${meta.id} has ${rows.length} rows, header says ${meta.rowCount}`,
        fetchedAt: meta.fetchedAt,
      };
    }
    return { status: "ok", batch: { ...meta, rows } };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e), fetchedAt: meta?.fetchedAt ?? null };
  }
}

/** Writes a validated batch. On a failed row insert the batch header is
 * deleted again (rows cascade), so a reader never sees a half batch. */
export async function insertRhBatch(args: {
  windowStart: string;
  windowEnd: string;
  rows: RhCalendarRow[];
  source: string;
}): Promise<RhBatchMeta> {
  const sb = createServerClient();
  const ins = await sb
    .from("robinhood_earnings_batches")
    .insert({ window_start: args.windowStart, window_end: args.windowEnd, row_count: args.rows.length, source: args.source })
    .select("id,fetched_at,window_start,window_end,row_count")
    .single();
  if (ins.error || !ins.data) throw new Error(`batch insert failed: ${ins.error?.message ?? "no row returned"}`);
  const meta = toMeta(ins.data as BatchRow);
  for (let i = 0; i < args.rows.length; i += INSERT_CHUNK) {
    const chunk = args.rows.slice(i, i + INSERT_CHUNK).map((r) => ({
      batch_id: meta.id,
      symbol: r.symbol,
      report_date: r.reportDate,
      timing: r.timing,
      verified: r.verified,
    }));
    const res = await sb.from("robinhood_earnings_rows").insert(chunk);
    if (res.error) {
      await sb.from("robinhood_earnings_batches").delete().eq("id", meta.id);
      throw new Error(`rows insert failed (batch rolled back): ${res.error.message}`);
    }
  }
  return meta;
}

export async function pruneOldRhBatches(now = new Date()): Promise<string | null> {
  const sb = createServerClient();
  const cutoff = new Date(now.getTime() - RH_BATCH_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const res = await sb.from("robinhood_earnings_batches").delete().lt("fetched_at", cutoff);
  return res.error ? res.error.message : null;
}
