// Schwab Account Data auto-import — turns real transactions into
// positions by routing to the SAME mechanisms a manual/screenshot
// import already uses. No new writer: real trade fills go through
// runBulkCreate (extracted from app/api/trades/bulk-create/route.ts),
// expirations through autoExpirePosition, assignments through
// recordAssignment + createStockFromAssignment /
// reduceStockLotForCallAssignment — all pre-existing, already-correct
// logic, called in-process instead of duplicated.
//
// Scope, deliberately narrow:
//   - Only the two accounts under the Account Data Schwab connection
//     (broker="schwab" / "schwab2"). Robinhood and covered_calls are
//     untouched — this module never queries or writes anything for
//     those brokers.
//   - Forward-only. The first poll run for an account establishes a
//     checkpoint at "now" and finds nothing — no historical backfill,
//     no touching positions that already exist in the Schwab accounts
//     from before this connection existed.
//   - Only transaction types that represent a real trade or an
//     assignment/expiration event (TRADE, RECEIVE_AND_DELIVER).
//     Dividends, SMA adjustments, journal entries, cash transfers are
//     landed (for the audit trail) but never turned into a position.
import { createServerClient } from "@/lib/supabase";
import { getAccountNumbers, getAccountTransactions } from "@/lib/schwab-account";
import { runBulkCreate, type TradeInput, type StockTradeInput } from "@/lib/bulk-create-trades";
import { autoExpirePosition, recordAssignment } from "@/lib/expire-positions";
import { reduceStockLotForCallAssignment, createStockFromAssignment } from "@/lib/positions";

// Account -> broker mapping. Exactly two accounts exist under this
// connection; a hardcoded table is the right size for that, not a
// config system. Matched by the last 3 digits of Schwab's real
// (unhashed) accountNumber, which getAccountNumbers()/transactions/
// orders all return directly.
const ACCOUNT_BROKER_MAP: Array<{ lastDigits: string; broker: "schwab" | "schwab2" }> = [
  { lastDigits: "123", broker: "schwab" },
  { lastDigits: "203", broker: "schwab2" },
];

function brokerForAccountNumber(accountNumber: string): "schwab" | "schwab2" | null {
  const s = String(accountNumber);
  const match = ACCOUNT_BROKER_MAP.find((a) => s.endsWith(a.lastDigits));
  return match?.broker ?? null;
}

type TransferItem = {
  instrument: {
    assetType: string;
    symbol?: string;
    underlyingSymbol?: string;
    putCall?: "PUT" | "CALL";
    strikePrice?: number;
    expirationDate?: string;
  };
  amount?: number;
  cost?: number;
  price?: number;
  positionEffect?: "OPENING" | "CLOSING";
  feeType?: string;
};

type SchwabTransaction = {
  activityId: number;
  type: string;
  time: string;
  description?: string;
  accountNumber: string | number;
  transferItems?: TransferItem[];
};

async function resolveAdminUserId(): Promise<string> {
  const sb = createServerClient();
  const res = await sb.from("users").select("id").eq("role", "admin").limit(1).maybeSingle();
  const row = res.data as { id: string } | null;
  if (!row) throw new Error("No admin user found — Schwab Account Data positions have no owner to stamp");
  return row.id;
}

function expiryDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

// The one non-fee leg of a TRADE/RECEIVE_AND_DELIVER transaction —
// fee legs are always assetType CURRENCY, real trades have exactly one
// OPTION or EQUITY leg alongside them.
function primaryLeg(txn: SchwabTransaction): TransferItem | null {
  return txn.transferItems?.find((ti) => ti.instrument.assetType !== "CURRENCY") ?? null;
}

export type PollReport = {
  broker: "schwab" | "schwab2";
  accountNumber: string;
  windowStart: string;
  windowEnd: string;
  transactionsSeen: number;
  transactionsLanded: number;
  tradesSubmitted: number;
  expirationsRecorded: number;
  assignmentsRecorded: number;
  skipped: number;
  errors: string[];
  ok: boolean;
};

export async function pollSchwabAccountTransactions(): Promise<PollReport[]> {
  const sb = createServerClient();
  const adminUserId = await resolveAdminUserId();
  const accounts = await getAccountNumbers();

  const reports: PollReport[] = [];
  for (const acct of accounts) {
    const broker = brokerForAccountNumber(acct.accountNumber);
    if (!broker) continue; // an account outside the known 2 — never touched

    const report = await pollOneAccount(sb, adminUserId, acct.accountNumber, acct.hashValue, broker);
    reports.push(report);

    await sb.from("schwab_account_poll_runs").insert({
      account_number: acct.accountNumber,
      broker,
      window_start: report.windowStart,
      window_end: report.windowEnd,
      transactions_seen: report.transactionsSeen,
      transactions_landed: report.transactionsLanded,
      fills_created: report.tradesSubmitted,
      expirations_recorded: report.expirationsRecorded,
      assignments_recorded: report.assignmentsRecorded,
      skipped_count: report.skipped,
      error_count: report.errors.length,
      errors: report.errors.length > 0 ? report.errors : null,
      ok: report.ok,
      run_finished_at: new Date().toISOString(),
    });
  }
  return reports;
}

async function pollOneAccount(
  sb: ReturnType<typeof createServerClient>,
  adminUserId: string,
  accountNumber: string,
  accountHash: string,
  broker: "schwab" | "schwab2",
): Promise<PollReport> {
  const errors: string[] = [];
  const windowEnd = new Date().toISOString();

  const lastRun = await sb
    .from("schwab_account_poll_runs")
    .select("window_end")
    .eq("broker", broker)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  // First run for this broker ever: checkpoint starts at "now" — no
  // backfill of whatever already exists in the account.
  const windowStart = (lastRun.data as { window_end: string } | null)?.window_end ?? windowEnd;

  const base: PollReport = {
    broker,
    accountNumber,
    windowStart,
    windowEnd,
    transactionsSeen: 0,
    transactionsLanded: 0,
    tradesSubmitted: 0,
    expirationsRecorded: 0,
    assignmentsRecorded: 0,
    skipped: 0,
    errors,
    ok: true,
  };

  if (windowStart === windowEnd) {
    // Same-instant window (first-ever run establishing the checkpoint) —
    // nothing to fetch.
    return base;
  }

  let transactions: SchwabTransaction[];
  try {
    transactions = (await getAccountTransactions(accountHash, {
      startDate: windowStart,
      endDate: windowEnd,
    })) as SchwabTransaction[];
  } catch (e) {
    errors.push(`transactions fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...base, ok: false };
  }
  base.transactionsSeen = transactions.length;

  // Land every transaction (full audit trail, including types we'll
  // never act on) — insert-only, unique on activity_id, so a re-poll
  // of an overlapping window is a no-op here regardless of what
  // happens downstream.
  for (const txn of transactions) {
    const ins = await sb
      .from("schwab_account_transactions")
      .insert({
        account_number: accountNumber,
        broker,
        activity_id: txn.activityId,
        type: txn.type,
        transaction_time: txn.time,
        raw: txn,
      })
      .select("id")
      .maybeSingle();
    if (ins.error) {
      // Unique-violation on activity_id means already landed by a
      // prior (possibly overlapping) run — expected, not an error.
      if (!ins.error.message.includes("duplicate key")) {
        errors.push(`land ${txn.activityId} failed: ${ins.error.message}`);
      }
      continue;
    }
    base.transactionsLanded += 1;
  }

  // Process only rows this run actually landed (unprocessed rows from
  // a prior failed run get picked up too, via the `processed=false`
  // filter, not just this run's fresh set).
  const unprocessedRes = await sb
    .from("schwab_account_transactions")
    .select("id,activity_id,type,transaction_time,raw")
    .eq("broker", broker)
    .eq("processed", false)
    .lte("transaction_time", windowEnd);
  const unprocessed = (unprocessedRes.data ?? []) as Array<{
    id: string;
    activity_id: number;
    type: string;
    transaction_time: string;
    raw: SchwabTransaction;
  }>;

  const tradeInputs: TradeInput[] = [];
  const stockInputs: StockTradeInput[] = [];
  // Maps back from a synthesized TradeInput/StockTradeInput to the
  // landed row(s) it came from, so the batch bulk-create result can be
  // reflected back onto schwab_account_transactions afterward.
  const tradeSourceRows: Array<{ id: string; activity_id: number }> = [];

  for (const row of unprocessed) {
    const txn = row.raw;
    if (txn.type === "TRADE") {
      const leg = primaryLeg(txn);
      if (!leg) {
        await markProcessed(sb, row.id, "skipped_no_leg", "no non-fee transferItem found");
        base.skipped += 1;
        continue;
      }
      if (leg.instrument.assetType === "OPTION") {
        const action = leg.positionEffect === "OPENING" ? "open" : "close";
        const amount = leg.amount ?? 0;
        const direction: "short" | "long" = amount < 0 ? "short" : "long";
        tradeInputs.push({
          symbol: leg.instrument.underlyingSymbol ?? "",
          action,
          contracts: Math.abs(amount),
          strike: leg.instrument.strikePrice ?? 0,
          expiry: expiryDateOnly(leg.instrument.expirationDate ?? txn.time),
          optionType: leg.instrument.putCall === "CALL" ? "call" : "put",
          ...(action === "open" ? { direction } : {}),
          premium: Math.abs(leg.price ?? 0),
          broker,
          timePlaced: txn.time.replace(/\+0000$/, ""),
          notes: `Schwab auto-import (activity ${txn.activityId})`,
        });
        tradeSourceRows.push({ id: row.id, activity_id: txn.activityId });
      } else if (leg.instrument.assetType === "EQUITY" && (leg.amount ?? 0) < 0) {
        // A stock SELL — the only stock-side case bulk-create accepts
        // (shares only ever arrive via assignment, handled separately
        // below). A stock BUY that isn't an assignment consequence
        // isn't a CSP-journal event this app models; skip it.
        stockInputs.push({
          symbol: leg.instrument.symbol ?? "",
          action: "sell",
          shares: Math.abs(leg.amount ?? 0),
          price: leg.price ?? 0,
          date: expiryDateOnly(txn.time),
          broker,
        });
        tradeSourceRows.push({ id: row.id, activity_id: txn.activityId });
      } else {
        await markProcessed(sb, row.id, "skipped_unhandled_leg", `assetType=${leg.instrument.assetType} amount=${leg.amount}`);
        base.skipped += 1;
      }
      continue;
    }

    if (txn.type === "RECEIVE_AND_DELIVER") {
      const leg = primaryLeg(txn);
      const desc = txn.description ?? "";
      if (!leg || leg.instrument.assetType !== "OPTION") {
        await markProcessed(sb, row.id, "skipped_unhandled", "RECEIVE_AND_DELIVER with no option leg");
        base.skipped += 1;
        continue;
      }
      const symbol = leg.instrument.underlyingSymbol ?? "";
      const strike = leg.instrument.strikePrice ?? 0;
      const expiry = expiryDateOnly(leg.instrument.expirationDate ?? txn.time);
      const optionType: "put" | "call" = leg.instrument.putCall === "CALL" ? "call" : "put";

      const posRes = await sb
        .from("positions")
        .select("id,avg_premium_sold")
        .eq("user_id", adminUserId)
        .eq("broker", broker)
        .eq("symbol", symbol)
        .eq("strike", strike)
        .eq("expiry", expiry)
        .eq("option_type", optionType)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      const pos = posRes.data as { id: string; avg_premium_sold: number | null } | null;
      if (!pos) {
        await markProcessed(
          sb,
          row.id,
          "error_no_matching_position",
          `no open ${broker} position for ${symbol} $${strike}${optionType === "call" ? "C" : "P"} ${expiry}`,
        );
        errors.push(`activity ${txn.activityId}: no matching open position for ${symbol} $${strike} ${expiry}`);
        continue;
      }

      if (desc.includes("Expiration")) {
        const result = await autoExpirePosition(pos.id, adminUserId);
        if (result.ok) {
          base.expirationsRecorded += 1;
          await markProcessed(sb, row.id, "expired", `position ${pos.id}`);
        } else {
          await markProcessed(sb, row.id, "error_expire_failed", result.reason ?? "unknown");
          errors.push(`activity ${txn.activityId}: autoExpirePosition failed (${result.reason})`);
        }
        continue;
      }

      if (desc.includes("Assignment")) {
        // Assignment always transacts at the strike — confirmed live
        // against real data (the paired stock leg's price equals the
        // option's strike exactly), so there's no separate "market
        // price at assignment" to look up.
        const assignResult = await recordAssignment(pos.id, strike, adminUserId);
        if (!assignResult.ok) {
          await markProcessed(sb, row.id, "error_assignment_failed", assignResult.reason ?? "unknown");
          errors.push(`activity ${txn.activityId}: recordAssignment failed (${assignResult.reason})`);
          continue;
        }
        if (optionType === "put") {
          const created = await createStockFromAssignment(adminUserId, [pos.id]);
          if (created.status !== 200) {
            errors.push(`activity ${txn.activityId}: createStockFromAssignment failed (status ${created.status})`);
          }
        } else {
          const shares = assignResult.contracts_closed * 100;
          const premiumPerShare = pos.avg_premium_sold !== null ? Number(pos.avg_premium_sold) : 0;
          const reduced = await reduceStockLotForCallAssignment(
            sb,
            adminUserId,
            symbol,
            shares,
            strike,
            expiry,
            premiumPerShare,
          );
          if (!reduced.ok) {
            errors.push(`activity ${txn.activityId}: reduceStockLotForCallAssignment failed (${reduced.reason})`);
          }
        }
        base.assignmentsRecorded += 1;
        await markProcessed(sb, row.id, "assigned", `position ${pos.id}`);
        continue;
      }

      await markProcessed(sb, row.id, "skipped_unhandled", `unrecognized RECEIVE_AND_DELIVER description: ${desc}`);
      base.skipped += 1;
      continue;
    }

    // Every other type — dividends, SMA adjustments, journal entries,
    // cash transfers — isn't a position event in this app's model.
    await markProcessed(sb, row.id, "skipped_irrelevant_type", txn.type);
    base.skipped += 1;
  }

  if (tradeInputs.length > 0 || stockInputs.length > 0) {
    const result = await runBulkCreate(adminUserId, {
      trades: tradeInputs,
      stockTrades: stockInputs,
      sourceTimezone: "UTC",
      // Never auto-confirm: a duplicate warning from bulk-create means
      // this exact fill was already recorded (by a prior run or a
      // manual entry) — the correct response is to leave it alone, not
      // push a second fill through.
      confirmDuplicates: false,
    });
    const json = (await result.json()) as {
      errors?: string[];
      duplicates?: string[];
      requires_confirmation?: boolean;
      positions_created?: number;
      fills_inserted?: number;
    };
    if (result.status === 200) {
      base.tradesSubmitted = tradeInputs.length + stockInputs.length;
      for (const r of tradeSourceRows) {
        await markProcessed(sb, r.id, "submitted", `bulk-create ok — fills_inserted=${json.fills_inserted ?? 0}`);
      }
    } else if (result.status === 409 || json.requires_confirmation) {
      // Duplicate(s) detected — mark the whole batch processed with a
      // clear reason rather than guessing which rows were the actual
      // duplicates. This is NOT retried: markProcessed sets
      // processed=true unconditionally, and the poller only re-reads
      // processed=false rows. If a genuine new trade was batched
      // alongside one duplicate, it's silently dropped here too —
      // that's why these surface in the activity-review panel
      // (Import + Dismiss), not just true error_ rows.
      for (const r of tradeSourceRows) {
        await markProcessed(
          sb,
          r.id,
          "skipped_duplicate",
          (json.duplicates ?? []).join("; ") || "bulk-create reported a suspected duplicate",
        );
      }
      base.skipped += tradeSourceRows.length;
    } else {
      for (const r of tradeSourceRows) {
        await markProcessed(sb, r.id, "error_bulk_create_failed", (json.errors ?? []).join("; ") || `status ${result.status}`);
      }
      errors.push(`bulk-create batch failed: ${(json.errors ?? []).join("; ") || `status ${result.status}`}`);
    }
  }

  base.ok = errors.length === 0;
  return base;
}

async function markProcessed(
  sb: ReturnType<typeof createServerClient>,
  id: string,
  outcome: string,
  detail: string,
): Promise<void> {
  const res = await sb
    .from("schwab_account_transactions")
    .update({ processed: true, processed_at: new Date().toISOString(), process_outcome: outcome, process_detail: detail })
    .eq("id", id);
  if (res.error) {
    console.warn(`[schwab-account-import] markProcessed(${id}) failed: ${res.error.message}`);
  }
}
