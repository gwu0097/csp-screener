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
  trade_date: string;
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

// Defensive: a "JSON only" system prompt can still leak a markdown
// fence or stray whitespace around the payload. Strip a wrapping
// ```json ... ``` fence if present, then parse.
function parseCourierBody(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const text = fenced ? fenced[1] : raw;
  return JSON.parse(text.trim());
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
          tradeDate: execution.trade_date,
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
  opts: { accountNumber: string; lookbackSince?: string },
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

  const tradeInputs: TradeInput[] = [];
  const sourceRows: Array<{ id: string; execution_id: string }> = [];

  for (const row of unprocessed) {
    const action: "open" | "close" = row.position_effect === "open" ? "open" : "close";
    const direction: "short" | "long" = row.side === "sell" ? "short" : "long";
    tradeInputs.push({
      symbol: row.symbol,
      action,
      contracts: row.contracts,
      strike: row.strike,
      expiry: row.expiry,
      optionType: row.option_type,
      ...(action === "open" ? { direction } : {}),
      premium: Math.abs(row.price),
      broker: "robinhood",
      timePlaced: row.execution_timestamp ? toTimePlaced(row.execution_timestamp) : undefined,
      notes: `Robinhood auto-import (execution ${row.execution_id})`,
    });
    sourceRows.push({ id: row.id, execution_id: row.execution_id });
  }

  if (tradeInputs.length > 0) {
    const result = await runBulkCreate(adminUserId, {
      trades: tradeInputs,
      sourceTimezone: "UTC",
      // Never auto-confirm — see the identical comment in
      // lib/schwab-account-import.ts. A duplicate warning means this
      // exact fill was already recorded; the correct response is to
      // leave it alone, surfaced in the review panel instead.
      confirmDuplicates: false,
    });
    const json = (await result.json()) as {
      errors?: string[];
      duplicates?: string[];
      requires_confirmation?: boolean;
      fills_inserted?: number;
    };
    if (result.status === 200) {
      report.tradesSubmitted = tradeInputs.length;
      for (const r of sourceRows) {
        await markProcessed(sb, r.id, "submitted", `bulk-create ok — fills_inserted=${json.fills_inserted ?? 0}`);
      }
    } else if (result.status === 409 || json.requires_confirmation) {
      for (const r of sourceRows) {
        await markProcessed(
          sb,
          r.id,
          "skipped_duplicate",
          (json.duplicates ?? []).join("; ") || "bulk-create reported a suspected duplicate",
        );
      }
      report.skipped += sourceRows.length;
    } else {
      for (const r of sourceRows) {
        await markProcessed(sb, r.id, "error_bulk_create_failed", (json.errors ?? []).join("; ") || `status ${result.status}`);
      }
      errors.push(`bulk-create batch failed: ${(json.errors ?? []).join("; ") || `status ${result.status}`}`);
    }
  }

  report.ok = errors.length === 0;

  await sb.from("robinhood_account_poll_runs").insert({
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
  });

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
