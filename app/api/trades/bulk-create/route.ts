import { NextRequest, NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";

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

// Pick the oldest open trade whose (symbol, strike, expiry, broker) matches
// and whose remaining contracts (original - sum of child closes) > 0. Returns
// null if nothing available to link to.
async function findOpenParent(
  supabase: ReturnType<typeof createServerClient>,
  input: TradeInput,
): Promise<TradeRow | null> {
  const broker = (input.broker ?? "schwab").toLowerCase();
  // Grab candidate parents: open trades matching the key.
  const { data: parents, error: pErr } = await supabase
    .from("trades")
    .select("*")
    .eq("action", "open")
    .eq("symbol", input.symbol.toUpperCase())
    .eq("strike", input.strike)
    .eq("expiry", input.expiry)
    .eq("broker", broker)
    .order("trade_date", { ascending: true });
  if (pErr || !parents || parents.length === 0) return null;

  // Sum close contracts per parent in one query.
  const parentIds = parents.map((p: TradeRow) => p.id);
  const { data: closes } = await supabase
    .from("trades")
    .select("parent_trade_id, contracts")
    .eq("action", "close")
    .in("parent_trade_id", parentIds);

  const closedByParent = new Map<string, number>();
  for (const c of (closes ?? []) as Array<{ parent_trade_id: string | null; contracts: number | null }>) {
    if (!c.parent_trade_id) continue;
    closedByParent.set(c.parent_trade_id, (closedByParent.get(c.parent_trade_id) ?? 0) + (c.contracts ?? 0));
  }

  for (const p of parents as TradeRow[]) {
    const original = p.contracts ?? 1;
    const closed = closedByParent.get(p.id) ?? 0;
    if (original - closed > 0) return p;
  }
  return null;
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
      let parentId: string | null = null;
      if (input.action === "close") {
        const parent = await findOpenParent(supabase, input);
        if (parent) {
          parentId = parent.id;
          matched += 1;
        } else {
          unmatched += 1;
        }
      }
      const row = buildInsert(input, parentId);
      const { error: iErr } = await supabase.from("trades").insert(row);
      if (iErr) {
        errors.push(`${input.symbol}: ${iErr.message}`);
        continue;
      }
      created += 1;
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
