// Local-only Parquet writer for full-chain post-earnings IV capture.
// NEVER import this from anything under app/ — it pulls in the native
// `duckdb` module, which has no business in the Vercel serverless
// bundle and isn't installed there. Local scripts (scripts/*.ts) only.
//
// Storage layout (confirmed with the user, Time Machine covers it once
// a destination is attached — no destination configured as of writing):
//   ~/Library/Application Support/csp-screener/chain-captures/
//     year=YYYY/month=MM/run-<runStartIso>-<phase>-part<N>.parquet
//     outcomes/year=YYYY/month=MM/run-<runStartIso>-<phase>-part<N>.parquet
//
// One file per (run, chunk) — Parquet files are immutable, so "append"
// here means "write another small file"; DuckDB glob-reads union them
// transparently. Chunking (not one file per whole run) is deliberate:
// a crash mid-run still leaves every completed chunk on disk instead
// of losing the entire run's data and outcome rows.
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import duckdb from "duckdb";

export const STORAGE_ROOT = resolve(
  homedir(),
  "Library/Application Support/csp-screener/chain-captures",
);

export type CapturePhase = "daily" | "t0" | "t1";

// Every column Schwab's chain response contains, plus join keys and
// capture context. iv_pct is named deliberately (not "iv") — Schwab
// returns implied vol as a raw percent (e.g. 44.08), while
// earnings_history.iv_before in Supabase stores a fraction (0.4408).
// Same name for different units would silently corrupt any query that
// joins the two stores.
export type ChainStrikeRow = {
  symbol: string;
  earnings_history_id: string | null;
  earnings_date: string | null;
  capture_phase: CapturePhase;
  trading_day_offset: number | null;
  capture_date: string;
  captured_at: string;
  underlying_price_schwab: number | null;
  underlying_price_yahoo: number | null;
  vix: number | null;
  option_type: "PUT" | "CALL";
  strike: number;
  expiration_date: string;
  dte: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  last: number | null;
  iv_pct: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  open_interest: number | null;
  volume: number | null;
  source: "schwab";
};

export type CaptureOutcome =
  | "fired"
  | "skipped_no_earnings"
  | "errored"
  | "schwab_disconnected"
  // Known-dead symbol (repeated permanent failures) — the Schwab call
  // was skipped entirely to save API budget, but this row still records
  // the attempt so suppression isn't indistinguishable from silence.
  | "suppressed"
  // Written by reconciliation, not the live run — either the scheduled
  // run for this date never fired at all, or it fired but this symbol
  // never reached a terminal fired/suppressed outcome. Exists so
  // "no data existed" and "the job died" are distinguishable later.
  | "missed";

export type OutcomeRow = {
  symbol: string | null;
  earnings_history_id: string | null;
  earnings_date: string | null;
  capture_phase: CapturePhase;
  trading_day_offset: number | null;
  capture_date: string;
  outcome: CaptureOutcome;
  error_message: string | null;
  strikes_written: number;
  attempts: number;
  recorded_at: string;
};

function partitionDir(base: string, dateIso: string): string {
  const [y, m] = dateIso.split("-");
  return resolve(base, `year=${y}`, `month=${m}`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Writes one JS array to one Parquet file via a temp JSON intermediate
// (DuckDB's read_json_auto → COPY ... TO PARQUET). Proven approach —
// tested live against a real 5,324-row Schwab chain sample before this
// was built: 21.9 bytes/row with ZSTD, no native-module issues on this
// Mac. Returns the written file path, or null if rows was empty (no
// empty Parquet files cluttering the tree).
// Explicit per-column DuckDB types — NOT read_json_auto. Auto-detection
// infers types independently per file, and free-text columns
// (error_message) can come back as VARCHAR in one chunk and JSON in
// another whenever an error string happens to contain literal `{...}`
// (Schwab's own error bodies do). That schema drift breaks any query
// selecting that column across the full glob — confirmed empirically,
// not hypothetical. An explicit schema makes every chunk file
// identical in type regardless of content.
const CHAIN_STRIKE_COLUMNS =
  "{'symbol':'VARCHAR','earnings_history_id':'VARCHAR','earnings_date':'DATE'," +
  "'capture_phase':'VARCHAR','trading_day_offset':'BIGINT','capture_date':'DATE'," +
  "'captured_at':'TIMESTAMP','underlying_price_schwab':'DOUBLE','underlying_price_yahoo':'DOUBLE'," +
  "'vix':'DOUBLE','option_type':'VARCHAR','strike':'DOUBLE','expiration_date':'DATE'," +
  "'dte':'BIGINT','bid':'DOUBLE','ask':'DOUBLE','mark':'DOUBLE','last':'DOUBLE'," +
  "'iv_pct':'DOUBLE','delta':'DOUBLE','gamma':'DOUBLE','theta':'DOUBLE','vega':'DOUBLE'," +
  "'open_interest':'BIGINT','volume':'BIGINT','source':'VARCHAR'}";

const OUTCOME_COLUMNS =
  "{'symbol':'VARCHAR','earnings_history_id':'VARCHAR','earnings_date':'DATE'," +
  "'capture_phase':'VARCHAR','trading_day_offset':'BIGINT','capture_date':'DATE'," +
  "'outcome':'VARCHAR','error_message':'VARCHAR','strikes_written':'BIGINT'," +
  "'attempts':'BIGINT','recorded_at':'TIMESTAMP'}";

async function writeParquet<T extends Record<string, unknown>>(
  rows: T[],
  targetDir: string,
  fileName: string,
  columnsSpec: string,
): Promise<string | null> {
  if (rows.length === 0) return null;
  ensureDir(targetDir);
  const tmpJson = resolve(targetDir, `.tmp-${fileName}.json`);
  const outPath = resolve(targetDir, fileName);
  writeFileSync(tmpJson, JSON.stringify(rows));
  try {
    await new Promise<void>((resolve_, reject) => {
      const db = new duckdb.Database(":memory:");
      const con = db.connect();
      const escapedTmp = tmpJson.replace(/'/g, "''");
      const escapedOut = outPath.replace(/'/g, "''");
      con.run(
        `CREATE TABLE t AS SELECT * FROM read_json('${escapedTmp}', columns=${columnsSpec});
         COPY t TO '${escapedOut}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
        (err: Error | null) => {
          con.close();
          if (err) reject(err);
          else resolve_();
        },
      );
    });
  } finally {
    try {
      unlinkSync(tmpJson);
    } catch {
      // best-effort cleanup
    }
  }
  return outPath;
}

export async function writeChainChunk(
  rows: ChainStrikeRow[],
  phase: CapturePhase,
  runStartedAt: string,
  captureDate: string,
  chunkIndex: number,
): Promise<string | null> {
  const dir = partitionDir(STORAGE_ROOT, captureDate);
  const runTag = runStartedAt.replace(/[:.]/g, "-");
  return writeParquet(rows, dir, `run-${runTag}-${phase}-part${chunkIndex}.parquet`, CHAIN_STRIKE_COLUMNS);
}

// Reads back every outcome row already logged today for (phase, date) —
// across however many invocations have run so far (main run + any
// same-day retry pass). This IS the persisted work-queue: "outstanding"
// is derived by subtracting completedSymbols from the full due list,
// rather than maintaining a second state file that could drift out of
// sync with what the outcome log actually says happened.
export async function queryTodayOutcomeStats(
  phase: CapturePhase,
  captureDate: string,
): Promise<{ counts: Record<string, number>; completedSymbols: Set<string> }> {
  const dir = partitionDir(resolve(STORAGE_ROOT, "outcomes"), captureDate);
  const empty = { counts: {} as Record<string, number>, completedSymbols: new Set<string>() };
  if (!existsSync(dir)) return empty;
  const glob = resolve(dir, `run-*-${phase}-part*.parquet`).replace(/'/g, "''");
  return new Promise((resolve_) => {
    const db = new duckdb.Database(":memory:");
    const con = db.connect();
    con.all(
      // A symbol can appear in more than one row for the same day — an
      // errored attempt from the main run, then a fired attempt from a
      // same-day retry pass. Counts must reflect each symbol's LATEST
      // outcome only; summing every row would double-count and inflate
      // fired/errored past the true due total (confirmed empirically —
      // due=303 summed to fired=897 before this ROW_NUMBER() fix).
      `WITH ranked AS (
         SELECT outcome, symbol,
                ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY recorded_at DESC) AS rn
         FROM read_parquet('${glob}')
         WHERE capture_date = '${captureDate}' AND symbol IS NOT NULL
       )
       SELECT outcome, symbol FROM ranked WHERE rn = 1`,
      (err: Error | null, res: unknown) => {
        con.close();
        const rows = (res ?? []) as Array<{ outcome: string; symbol: string | null }>;
        if (err) {
          // No files matching the glob yet is the common case (first
          // invocation of the day) — DuckDB errors on a zero-match glob
          // rather than returning zero rows. Fail open to "nothing
          // completed yet" either way; worst case a retry pass
          // reprocesses a symbol that actually already succeeded.
          resolve_(empty);
          return;
        }
        const counts: Record<string, number> = {};
        const completedSymbols = new Set<string>();
        for (const r of rows) {
          counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
          if ((r.outcome === "fired" || r.outcome === "suppressed") && r.symbol) {
            completedSymbols.add(r.symbol);
          }
        }
        resolve_({ counts, completedSymbols });
      },
    );
  });
}

export async function writeOutcomeChunk(
  rows: OutcomeRow[],
  phase: CapturePhase,
  runStartedAt: string,
  captureDate: string,
  chunkIndex: number,
): Promise<string | null> {
  const dir = partitionDir(resolve(STORAGE_ROOT, "outcomes"), captureDate);
  const runTag = runStartedAt.replace(/[:.]/g, "-");
  return writeParquet(rows, dir, `run-${runTag}-${phase}-part${chunkIndex}.parquet`, OUTCOME_COLUMNS);
}
