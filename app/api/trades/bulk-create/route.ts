import { NextRequest, NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";
import { allocateCloseFIFO } from "@/lib/trade-allocation";

export const dynamic = "force-dynamic";

export type TradeInput = {
  symbol: string;
  action: "open" | "close";
  contracts: number;
  strike: number;
  expiry: string;          // YYYY-MM-DD
  optionType?: "put" | "call"; // currently only puts are screened, but honored
  premium: number;
  broker?: string | null;
  // Preferred source for trade_date / closed_at when importing history.
  // parse-screenshot pulls this from the ToS "Time Placed" column.
  timePlaced?: string;     // YYYY-MM-DD
  trade_date?: string;     // defaults to today
  earnings_date?: string;  // optional; not required for close rows
  notes?: string | null;
};

type BulkBody = { trades?: TradeInput[] };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type InsertRow = Omit<TradeRow, "id" | "created_at">;

function buildInsert(input: TradeInput, parentId: string | null): InsertRow {
  const today = todayIso();
  const broker = (input.broker ?? "schwab").toLowerCase();
  // timePlaced (from screenshot import) takes precedence over explicit
  // trade_date; both fall back to today. Closes also honor timePlaced so
  // a multi-day history import lands on its real closed_at date.
  const effectiveDate = input.timePlaced ?? input.trade_date ?? today;
  return {
    symbol: input.symbol.toUpperCase(),
    trade_date: effectiveDate,
    earnings_date: input.earnings_date ?? today,
    entry_stock_price: null,
    strike: input.strike,
    expiry: input.expiry,
    premium_sold: input.action === "open" ? input.premium : 0,
    premium_bought: input.action === "close" ? input.premium : null,
    closed_at: input.action === "close" ? effectiveDate : null,
    outcome: null,
    crush_grade: null,
    opportunity_grade: null,
    notes: input.notes ?? null,
    broker,
    contracts: input.contracts,
    action: input.action,
    parent_trade_id: parentId,
    stock_price_at_entry: null,
    stock_price_at_close: null,
    delta_at_entry: null,
    em_pct_at_entry: null,
    strike_multiple: null,
  };
}

export async function POST(req: NextRequest) {
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemsRaw = Array.isArray(body.trades) ? body.trades : [];
  if (itemsRaw.length === 0) {
    return NextResponse.json({ error: "No trades provided" }, { status: 400 });
  }

  // Process all opens before any closes within the same batch. ToS exports
  // chronologically (newest first), so a 3-day screenshot often has today's
  // closes ABOVE the opens they're closing against. Without this sort,
  // findOpenParent runs while the matching open hasn't been inserted yet
  // and every close ends up orphaned (parent_trade_id=null).
  // Stable sort preserves input order within each action group.
  const items = [...itemsRaw].sort((a, b) => {
    const aw = a.action === "open" ? 0 : a.action === "close" ? 1 : 2;
    const bw = b.action === "open" ? 0 : b.action === "close" ? 1 : 2;
    return aw - bw;
  });

  const supabase = createServerClient();
  const errors: string[] = [];
  let created = 0;
  let matched = 0;
  let unmatched = 0;

  // Sequential on purpose: the same batch may close multiple contracts
  // against the same parent; each close must see earlier inserts when
  // computing remaining capacity.
  for (const input of items) {
    const required = ["symbol", "action", "contracts", "strike", "expiry", "premium"] as const;
    const missing = required.find((k) => {
      const v = input[k];
      return v === undefined || v === null || v === "";
    });
    if (missing) {
      errors.push(`Skipped ${input.symbol ?? "?"}: missing ${missing}`);
      continue;
    }
    if (input.action !== "open" && input.action !== "close") {
      errors.push(`Skipped ${input.symbol}: invalid action ${input.action}`);
      continue;
    }

    try {
      if (input.action === "open") {
        const row = buildInsert(input, null);
        const { error: iErr } = await supabase.from("trades").insert(row);
        if (iErr) {
          errors.push(`${input.symbol}: ${iErr.message}`);
          continue;
        }
        created += 1;
        continue;
      }

      // Close: distribute across open parents FIFO. A single close
      // transaction can span multiple parent tranches (e.g. a 6-contract
      // close against two 3-contract opens) — we insert one child row per
      // parent consumed, plus one orphan child for any residue.
      const { allocations, fullyClosedParentIds } = await allocateCloseFIFO(
        supabase,
        {
          symbol: input.symbol,
          strike: input.strike,
          expiry: input.expiry,
          broker: input.broker ?? "schwab",
        },
        input.contracts,
      );
      for (const alloc of allocations) {
        const row = buildInsert(
          { ...input, contracts: alloc.contracts },
          alloc.parentId,
        );
        const { error: iErr } = await supabase.from("trades").insert(row);
        if (iErr) {
          errors.push(`${input.symbol}: ${iErr.message}`);
          continue;
        }
        created += 1;
        if (alloc.parentId) matched += 1;
        else unmatched += 1;
      }
      // Flip closed_at on parents whose remaining capacity just hit zero.
      // UI + other routes already exclude parent rows with closed_at set,
      // so this keeps the "remaining=0 but still flagged open" state from
      // showing up in queries that don't compute child sums.
      const closedAtDate = input.timePlaced ?? input.trade_date ?? todayIso();
      for (const pid of fullyClosedParentIds) {
        const { error: uErr } = await supabase
          .from("trades")
          .update({ closed_at: closedAtDate })
          .eq("id", pid);
        if (uErr) {
          errors.push(`${input.symbol} closed_at set on ${pid}: ${uErr.message}`);
        }
      }
    } catch (e) {
      errors.push(
        `${input.symbol}: ${e instanceof Error ? e.message : "insert failed"}`,
      );
    }
  }

  console.log(
    `[bulk-create] processed=${items.length} created=${created} matched=${matched} unmatched=${unmatched} errors=${errors.length}`,
  );
  return NextResponse.json({ created, matched, unmatched, errors });
}
