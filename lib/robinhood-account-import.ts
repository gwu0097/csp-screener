// Robinhood option-fill auto-import — same shape as
// lib/schwab-account-import.ts (land raw, dedupe, translate to
// TradeInput, submit through the SAME runBulkCreate every other import
// path uses), but fed by a local "courier" instead of a server-side
// OAuth poll: a scheduled headless `claude -p` run calls the Robinhood
// MCP's get_option_orders and POSTs the raw JSON to
// app/api/robinhood-account/poll-transactions, which calls
// ingestAndProcessRobinhoodOrders() below. See
// migrations/2026-08-21-robinhood-account-transactions.sql for why
// there's no window_start/window_end cursor here — the courier always
// submits a rolling lookback and idempotency comes entirely from
// execution_id's uniqueness.
//
// Scope, deliberately narrow (v1):
//   - Options only. Equity fills (get_equity_orders) are out of scope —
//     a clean phase 2.
//   - Fills only — opens, closes, and rolls. Robinhood's order API has
//     no equivalent of Schwab's RECEIVE_AND_DELIVER feed, so expirations
//     and assignments are NOT detected here. That's a defined phase 1b
//     (diff get_option_positions against open robinhood positions, or
//     mine get_pnl_trade_history) routed through the same
//     autoExpirePosition/recordAssignment writers Schwab already uses.
//   - Never filter on order `state` — a cancelled GFD order can still
//     carry a real partial fill (confirmed live: a 7-contract TJX order
//     landed in `state: cancelled` with 1 real execution). Presence of
//     `legs[].executions[]` is the only signal that matters.
import { createServerClient } from "@/lib/supabase";
import { runBulkCreate, type TradeInput } from "@/lib/bulk-create-trades";

// v1 targets exactly one account — the individual margin options
// account the user's screenshots come from. No hardcoded default
// here deliberately: this repo is public, and unlike Schwab's
// ACCOUNT_BROKER_MAP (which only ever stores the last 3 digits), a
// Robinhood account number has no natural truncation that still
// dedupes safely — so the real value lives only in the courier's own
// untracked .env.local (ROBINHOOD_ACCOUNT_NUMBER) and is passed
// through per-request. Missing it is a hard error, not a silent
// fallback.

type RhExecution = {
  id: string;
  price: string;
  quantity: string;
  // Not reliably present — a 2026-08-27 incident found an execution
  // whose trade_date was absent from the MCP response entirely,
  // violating robinhood_account_transactions' `date not null` and
  // silently dropping that fill from every subsequent poll (the
  // insert failure recurs every run since the row never lands).
  // Fell back to deriving from `timestamp` below rather than trusting
  // this field unconditionally.
  trade_date?: string;
  timestamp: string;
};

type RhLeg = {
  side: "buy" | "sell";
  position_effect: "open" | "close";
  expiration_date: string;
  strike_price: string;
  option_type: "call" | "put";
  executions?: RhExecution[];
};

type RhOrder = {
  id: string;
  chain_symbol: string;
  state: string;
  legs: RhLeg[];
};

// The courier is instructed to emit the MCP tool's raw JSON verbatim,
// but LLM output isn't a guaranteed exact shape — accept the wrapped
// {data:{orders:[...]}} form the tool actually returns, a bare
// {orders:[...]}, or a raw array, rather than trusting one specific
// nesting.
function extractOrders(input: unknown): RhOrder[] {
  if (Array.isArray(input)) return input as RhOrder[];
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as RhOrder[];
    if (obj.data && typeof obj.data === "object") {
      const data = obj.data as Record<string, unknown>;
      if (Array.isArray(data.orders)) return data.orders as RhOrder[];
    }
  }
  return [];
}

// Defensive: a "JSON only" system prompt is not a guarantee. Observed
// live (2026-08-26 incident): claude -p's stdout is prefixed with an
// unrelated CLI permission-warning line before the actual response,
// and whether the JSON itself gets wrapped in a ```json fence is
// inconsistent — a plain fence-regex strip failed to find/close the
// fence correctly and left trailing content that broke JSON.parse. A
// second, separate failure that same day was genuinely truncated
// output (not a wrapping problem) — traced to the courier's prompt
// asking Claude to reproduce a large, irrelevant "guide" text field
// verbatim alongside the real data; the courier no longer asks for
// that field, so the expected top-level shape here is now a bare
// array most of the time, though this still accepts an object too.
// Brace/bracket-counting finds the first `{` or `[`, then walks
// forward tracking string state (so braces/brackets inside quoted
// strings don't confuse it) until the matching closer — the first
// COMPLETE top-level JSON value in the text, regardless of what
// surrounds it.
function extractFirstJsonValue(text: string): string {
  let start = -1;
  let openChar = "";
  let closeChar = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      start = i;
      openChar = text[i];
      closeChar = openChar === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) throw new Error("No JSON value found in courier output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced JSON value in courier output");
}

function parseCourierBody(raw: string): unknown {
  return JSON.parse(extractFirstJsonValue(raw));
}

async function resolveAdminUserId(): Promise<string> {
  const sb = createServerClient();
  const res = await sb.from("users").select("id").eq("role", "admin").limit(1).maybeSingle();
  const row = res.data as { id: string } | null;
  if (!row) throw new Error("No admin user found — Robinhood auto-import positions have no owner to stamp");
  return row.id;
}

// One execution, flattened out of its order/leg — the actual unit of
// work. A single Robinhood order can carry multiple legs (a roll: one
// close leg + one open leg) and each leg can carry multiple executions
// (a partial fill that completes over several days) — this is why the
// walk is order -> leg -> execution, not just order -> leg like
// Schwab's single-non-fee-leg model.
type FlatFill = {
  executionId: string;
  orderId: string;
  symbol: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  side: "buy" | "sell";
  positionEffect: "open" | "close";
  contracts: number;
  price: number;
  tradeDate: string;
  timestamp: string;
  raw: { order: Pick<RhOrder, "id" | "chain_symbol" | "state">; leg: Omit<RhLeg, "executions">; execution: RhExecution };
};

function flattenOrders(orders: RhOrder[]): FlatFill[] {
  const out: FlatFill[] = [];
  for (const order of orders) {
    for (const leg of order.legs ?? []) {
      for (const execution of leg.executions ?? []) {
        out.push({
          executionId: execution.id,
          orderId: order.id,
          symbol: order.chain_symbol,
          strike: Number(leg.strike_price),
          expiry: leg.expiration_date,
          optionType: leg.option_type,
          side: leg.side,
          positionEffect: leg.position_effect,
          contracts: Number(execution.quantity),
          price: Number(execution.price),
          // execution.trade_date is sometimes absent from the MCP
          // response (see RhExecution's comment) — fall back to the
          // date portion of the execution timestamp, which is always
          // present, rather than landing a null and losing the fill
          // every run.
          tradeDate: execution.trade_date ?? execution.timestamp.slice(0, 10),
          timestamp: execution.timestamp,
          raw: {
            order: { id: order.id, chain_symbol: order.chain_symbol, state: order.state },
            leg: { side: leg.side, position_effect: leg.position_effect, expiration_date: leg.expiration_date, strike_price: leg.strike_price, option_type: leg.option_type },
            execution,
          },
        });
      }
    }
  }
  return out;
}

// "2026-08-18T19:29:47.869000Z" -> "2026-08-18T19:29:47" — same intent
// as Schwab's txn.time.replace(/\+0000$/, ""): strip to a bare
// datetime so sourceTimezone:"UTC" drives the exact UTC -> PT
// conversion in toPstDate(), rather than double-applying a timezone.
// Sliced by fixed position rather than a suffix regex because this
// value round-trips through Postgres first — PostgREST may hand it
// back as "...869000+00:00" instead of the MCP's original
// "...869000Z", and the "YYYY-MM-DDTHH:MM:SS" prefix is always at the
// same offset in either form.
function toTimePlaced(ts: string): string {
  return ts.slice(0, 19);
}

export type RobinhoodPollReport = {
  broker: "robinhood";
  accountNumber: string;
  ordersSeen: number;
  executionsSeen: number;
  executionsLanded: number;
  tradesSubmitted: number;
  skipped: number;
  errors: string[];
  ok: boolean;
};

export async function ingestAndProcessRobinhoodOrders(
  rawBody: unknown,
  opts: { accountNumber: string; lookbackSince?: string; runRowId?: string },
): Promise<RobinhoodPollReport> {
  const sb = createServerClient();
  const adminUserId = await resolveAdminUserId();
  const accountNumber = opts.accountNumber;
  if (!accountNumber) {
    throw new Error("accountNumber is required — no default is hardcoded (this repo is public)");
  }
  const errors: string[] = [];

  const parsed = typeof rawBody === "string" ? parseCourierBody(rawBody) : rawBody;
  const orders = extractOrders(parsed);
  const fills = flattenOrders(orders);

  const report: RobinhoodPollReport = {
    broker: "robinhood",
    accountNumber,
    ordersSeen: orders.length,
    executionsSeen: fills.length,
    executionsLanded: 0,
    tradesSubmitted: 0,
    skipped: 0,
    errors,
    ok: true,
  };

  // Land every execution (full audit trail) — insert-only, unique on
  // execution_id, so a re-poll of an overlapping rolling lookback is a
  // no-op here regardless of what happens downstream.
  for (const fill of fills) {
    const ins = await sb
      .from("robinhood_account_transactions")
      .insert({
        execution_id: fill.executionId,
        order_id: fill.orderId,
        account_number: accountNumber,
        broker: "robinhood",
        symbol: fill.symbol,
        strike: fill.strike,
        expiry: fill.expiry,
        option_type: fill.optionType,
        side: fill.side,
        position_effect: fill.positionEffect,
        contracts: fill.contracts,
        price: fill.price,
        trade_date: fill.tradeDate,
        execution_timestamp: fill.timestamp,
        raw: fill.raw,
      })
      .select("id")
      .maybeSingle();
    if (ins.error) {
      if (!ins.error.message.includes("duplicate key")) {
        errors.push(`land ${fill.executionId} failed: ${ins.error.message}`);
      }
      continue;
    }
    report.executionsLanded += 1;
  }

  // Process only unprocessed rows — includes anything left over from a
  // prior failed run, not just what this run just landed, same as the
  // Schwab poller.
  const unprocessedRes = await sb
    .from("robinhood_account_transactions")
    .select("id,execution_id,symbol,strike,expiry,option_type,side,position_effect,contracts,price,execution_timestamp")
    .eq("broker", "robinhood")
    .eq("processed", false);
  const unprocessed = (unprocessedRes.data ?? []) as Array<{
    id: string;
    execution_id: string;
    symbol: string;
    strike: number;
    expiry: string;
    option_type: "put" | "call";
    side: "buy" | "sell";
    position_effect: "open" | "close";
    contracts: number;
    price: number;
    execution_timestamp: string | null;
  }>;

  // Carries each synthesized TradeInput together with the landed row
  // it came from — see lib/schwab-account-import.ts's identical
  // `pending` array for the full reasoning (a 2026-08-26 incident on
  // that pipeline: one bad leg in a batch caused an unrelated valid
  // trade to be marked errored with the bad leg's error message,
  // purely because bulk-create has no partial success). This file had
  // the same three-parallel-array pattern and the same bug, just not
  // yet hit — confirmed live the next day: an NVDA $190P open got
  // marked needs_review with a completely unrelated $185P duplicate
  // warning, purely because it shared a batch with two ambiguous
  // $185P fills.
  const pending: Array<{ row: { id: string; execution_id: string }; input: TradeInput }> = [];

  for (const row of unprocessed) {
    const action: "open" | "close" = row.position_effect === "open" ? "open" : "close";
    const direction: "short" | "long" = row.side === "sell" ? "short" : "long";
    // A short call is categorically a covered call, never a CSP —
    // redirected to broker="covered_calls" instead of "robinhood" so
    // it's born in the bucket every later broker-reported event on
    // this same contract will also resolve to. Mirrors the identical
    // fix in lib/schwab-account-import.ts's effectiveOptionBroker —
    // see that comment for the 2026-08-30 incident this prevents.
    //
    // direction is only consulted for OPENS — fixed 2026-09-04 alongside
    // the identical Schwab bug (see effectiveOptionBrokerForClose there
    // for the full reasoning). For a CLOSE, `direction` is the sign of
    // THIS fill (buy-to-close a short call computes as "long", the
    // mechanical opposite of the position's real direction), not the
    // position's held direction — using it for close-side bucket
    // routing silently un-routes the close from covered_calls back to
    // "robinhood", where the matcher in lib/bulk-create-trades.ts can
    // never find the position. A call is categorically a covered call
    // once it exists, regardless of which fill is being processed.
    const effectiveBroker =
      action === "open"
        ? row.option_type === "call" && direction === "short"
          ? "covered_calls"
          : "robinhood"
        : row.option_type === "call"
          ? "covered_calls"
          : "robinhood";
    pending.push({
      row: { id: row.id, execution_id: row.execution_id },
      input: {
        symbol: row.symbol,
        action,
        contracts: row.contracts,
        strike: row.strike,
        expiry: row.expiry,
        optionType: row.option_type,
        ...(action === "open" ? { direction } : {}),
        premium: Math.abs(row.price),
        broker: effectiveBroker,
        timePlaced: row.execution_timestamp ? toTimePlaced(row.execution_timestamp) : undefined,
        notes: `Robinhood auto-import (execution ${row.execution_id})`,
        // Robinhood's own unique id for this fill. Lets duplicate
        // detection in runBulkCreate prove two fills with identical
        // contracts/premium/date are genuinely separate executions
        // (the 2026-08-27 NVDA $185P case: two real fills, same
        // contracts/premium/date, wrongly flagged as one duplicate)
        // rather than guessing from economic terms alone.
        externalId: row.execution_id,
      },
    });
  }

  type BulkCreateJson = {
    errors?: string[];
    duplicates?: string[];
    requires_confirmation?: boolean;
    fills_inserted?: number;
  };

  if (pending.length > 0) {
    const result = await runBulkCreate(adminUserId, {
      trades: pending.map((p) => p.input),
      sourceTimezone: "UTC",
      // Never auto-confirm — see the identical comment in
      // lib/schwab-account-import.ts. A duplicate warning means this
      // exact fill was already recorded; the correct response is to
      // leave it alone, surfaced in the review panel instead.
      confirmDuplicates: false,
    });
    const json = (await result.json()) as BulkCreateJson;

    if (result.status === 200) {
      report.tradesSubmitted = pending.length;
      for (const p of pending) {
        await markProcessed(sb, p.row.id, "submitted", `bulk-create ok — fills_inserted=${json.fills_inserted ?? 0}`);
      }
    } else {
      // Batch rejected — retry each row individually so only the
      // row(s) that genuinely fail (or are genuinely ambiguous
      // duplicates) get flagged, attributed to that row specifically.
      //
      // Opens-phase, then closes-phase — NOT one flat sequential loop.
      // See the identical comment in lib/schwab-account-import.ts for
      // the full reasoning (a close may depend on a position an open
      // in this same batch just created; a 2026-08-27 incident found
      // sequential individual retries blowing past the route's 60s
      // Vercel timeout on a batch with several failing items). Each
      // phase runs concurrently; phases run in order.
      const retryOne = async (p: (typeof pending)[number]): Promise<void> => {
        const singleResult = await runBulkCreate(adminUserId, {
          trades: [p.input],
          sourceTimezone: "UTC",
          confirmDuplicates: false,
        });
        const singleJson = (await singleResult.json()) as BulkCreateJson;
        if (singleResult.status === 200) {
          report.tradesSubmitted += 1;
          await markProcessed(sb, p.row.id, "submitted", `bulk-create ok (individual retry after batch failure) — fills_inserted=${singleJson.fills_inserted ?? 0}`);
        } else if (singleResult.status === 409 || singleJson.requires_confirmation) {
          report.skipped += 1;
          await markProcessed(
            sb,
            p.row.id,
            "skipped_duplicate",
            (singleJson.duplicates ?? []).join("; ") || "bulk-create reported a suspected duplicate",
          );
        } else {
          const detail = (singleJson.errors ?? []).join("; ") || `status ${singleResult.status}`;
          errors.push(`execution ${p.row.execution_id}: ${detail}`);
          await markProcessed(sb, p.row.id, "error_bulk_create_failed", detail);
        }
      };
      const opens = pending.filter((p) => p.input.action === "open");
      const closes = pending.filter((p) => p.input.action !== "open");
      await Promise.all(opens.map(retryOne));
      await Promise.all(closes.map(retryOne));
    }
  }

  report.ok = errors.length === 0;

  const runRow = {
    account_number: accountNumber,
    broker: "robinhood",
    lookback_since: opts?.lookbackSince ?? null,
    orders_seen: report.ordersSeen,
    executions_seen: report.executionsSeen,
    executions_landed: report.executionsLanded,
    fills_created: report.tradesSubmitted,
    skipped_count: report.skipped,
    error_count: report.errors.length,
    errors: report.errors.length > 0 ? report.errors : null,
    ok: report.ok,
    run_finished_at: new Date().toISOString(),
  };
  // A "running" placeholder row (see /api/robinhood-account/poll-run-
  // start) already exists for this run — close it out in place rather
  // than inserting a second row, or the Positions page's "running
  // since..." state would never clear.
  if (opts?.runRowId) {
    await sb.from("robinhood_account_poll_runs").update(runRow).eq("id", opts.runRowId);
  } else {
    await sb.from("robinhood_account_poll_runs").insert(runRow);
  }

  return report;
}

async function markProcessed(
  sb: ReturnType<typeof createServerClient>,
  id: string,
  outcome: string,
  detail: string,
): Promise<void> {
  const res = await sb
    .from("robinhood_account_transactions")
    .update({ processed: true, processed_at: new Date().toISOString(), process_outcome: outcome, process_detail: detail })
    .eq("id", id);
  if (res.error) {
    console.warn(`[robinhood-account-import] markProcessed(${id}) failed: ${res.error.message}`);
  }
}
