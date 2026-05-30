import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase";
import {
  remainingContracts,
  avgPremiumSold,
  realizedPnl,
  type Fill,
  type PositionRow,
} from "@/lib/positions";
import { buildSnapshotRow, fetchChainWideSafe } from "@/lib/snapshots";
import { recordPositionOutcome } from "@/lib/post-earnings";

export const dynamic = "force-dynamic";

// Shape the screenshot parser and manual-add modal send us.
export type TradeInput = {
  symbol: string;
  action: "open" | "close";
  contracts: number;
  strike: number;
  expiry: string; // YYYY-MM-DD
  optionType?: "put" | "call";
  premium: number;
  broker?: string | null;
  // "YYYY-MM-DD" (date-only) or "YYYY-MM-DDTHH:MM:SS" (datetime, preferred).
  // The datetime form lets toPstDate() do an exact source-tz → PT conversion.
  timePlaced?: string;
  trade_date?: string;
  notes?: string | null;
};

// Stock-sell input — used to close (fully or partially) an existing
// stock_long position that came in via the assignment flow. The buy
// side has no bulk-create entry point because shares only arrive
// through option assignment; this branch is sell-only.
export type StockTradeInput = {
  symbol: string;
  action: "sell"; // buy not supported here — shares originate from assignment
  shares: number;
  price: number; // per-share sale price
  date: string; // YYYY-MM-DD
  broker?: string | null;
};

type BulkBody = {
  trades?: TradeInput[];
  stockTrades?: StockTradeInput[];
  // Code for the timezone the broker screenshot was displayed in.
  // Drives toPstDate() conversion below so HK / Tokyo etc. users
  // store PST calendar dates regardless of their broker's display
  // timezone. Defaults to "PT" (no conversion when user's normal
  // timezone is PT).
  sourceTimezone?: string;
};

// Code → IANA timezone identifier. Add new codes to both this map
// and the import-screenshot-modal dropdown — the route silently
// falls back to ET on an unknown code so a stale modal can't
// corrupt the calendar date.
const TZ_BY_CODE: Record<string, string> = {
  ET: "America/New_York",
  PT: "America/Los_Angeles",
  HK: "Asia/Hong_Kong",
  CN: "Asia/Shanghai",
  JP: "Asia/Tokyo",
  UTC: "UTC",
};

// Convert a source-timezone moment (or date) to the matching PST/PDT
// calendar date.
//
// Accepts two input forms:
//   1. "YYYY-MM-DDTHH:MM:SS" — exact wall-clock time in the source TZ.
//      Used for an exact conversion. This is the path Schwab takes when
//      Gemini extracts the full "Time Placed" datetime from the ToS UI.
//   2. "YYYY-MM-DD" — date only. Falls back to a 17:00 source-local
//      anchor. 17:00 (rather than noon or midnight) lands cleanly on
//      the same PT calendar day for every supported timezone:
//        HK/CN 17:00 → PDT 02:00 same day
//        JP    17:00 → PDT 01:00 same day
//        ET    17:00 → PDT 14:00 same day
//        UTC   17:00 → PDT 10:00 same day
//      The earlier noon anchor was off by one full day for HK/CN/JP
//      (noon HK → PDT 21:00 prev day), which corrupted historical
//      imports — see scripts/fix-pst-dates.ts and the f983edf3
//      cleanup script.
//
// When source is PT/PST the conversion is a no-op (just strip any
// time suffix and return the date portion).
function toPstDate(input: string, sourceTzCode?: string): string {
  const sourceTz = TZ_BY_CODE[sourceTzCode ?? "PT"] ?? "America/Los_Angeles";
  const dt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  const dm = !dt ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(input) : null;
  const m = dt ?? dm;
  if (!m) return input;
  if (sourceTz === "America/Los_Angeles") return `${m[1]}-${m[2]}-${m[3]}`;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = dt ? Number(dt[4]) : 17;
  const mi = dt ? Number(dt[5]) : 0;
  const s = dt && dt[6] ? Number(dt[6]) : 0;

  // Treat the wall-clock components as if they were UTC, find the
  // source-TZ DST-aware offset at that date, then subtract the offset
  // to get the real UTC instant for that source-tz wall clock.
  let utcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: sourceTz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const tzTimeAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = tzTimeAsUtc - utcMs;
  utcMs -= offsetMs;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcMs));
}

function todayPst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeBroker(b?: string | null): string {
  return (b ?? "schwab").toLowerCase();
}

// Options never expire on Sat/Sun. Broker screenshots (ThinkOrSwim, etc.)
// sometimes display weekly settlement dates (the Sunday after expiry) or
// the model parses "APR 24 '26" ambiguously and lands on 04-26. Snap any
// weekend expiry back to the preceding Friday so the stored value is a
// real Schwab expiry key and every downstream chain lookup hits cleanly.
function normalizeExpiryToWeekday(expiry: string): {
  normalized: string;
  wasWeekend: boolean;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!match) return { normalized: expiry, wasWeekend: false };
  const d = new Date(expiry + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return { normalized: expiry, wasWeekend: false };
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
  if (day !== 0 && day !== 6) return { normalized: expiry, wasWeekend: false };
  const subtract = day === 6 ? 1 : 2;
  d.setUTCDate(d.getUTCDate() - subtract);
  return { normalized: d.toISOString().slice(0, 10), wasWeekend: true };
}

// For each incoming fill, find (or create) the matching position, then
// insert a fills row and rebuild the position's aggregates from scratch
// off its full fill set.
// Atomic two-phase import:
//   Phase 1 — validate the entire payload READ-ONLY. Collect every
//             error across all trades. If any error fires, return
//             422 with the full list and ZERO writes happen.
//   Phase 2 — once Phase 1 is clean, execute every insert/update.
//             If anything blows up mid-batch, delete every fill and
//             position we stamped with this import_batch_id and
//             recompute aggregates on any pre-existing position we
//             touched, restoring its pre-batch state.
//
// Best-effort side effects (close snapshots, tracked-ticker grade
// merge, post-earnings outcome) run AFTER the core inserts succeed.
// Failures there log but don't roll the whole batch back — they're
// observational records, not the trades themselves.
export async function POST(req: NextRequest) {
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemsRaw = Array.isArray(body.trades) ? body.trades : [];
  const stockItemsRaw = Array.isArray(body.stockTrades) ? body.stockTrades : [];
  if (itemsRaw.length === 0 && stockItemsRaw.length === 0) {
    return NextResponse.json({ error: "No trades provided" }, { status: 400 });
  }
  const sourceTimezone = typeof body.sourceTimezone === "string" ? body.sourceTimezone : "PT";

  // Opens first within the batch — that way a position exists before any
  // close fill in the same batch tries to attach to it.
  const items = [...itemsRaw].sort((a, b) => {
    const aw = a.action === "open" ? 0 : a.action === "close" ? 1 : 2;
    const bw = b.action === "open" ? 0 : b.action === "close" ? 1 : 2;
    return aw - bw;
  });
  const stockInputs = stockItemsRaw;

  const supabase = createServerClient();
  const errors: string[] = [];

  // One batch_id per bulk-create call. Stamped on every NEW position
  // and EVERY fill we insert below so the "Undo last import" flow on
  // the Positions page can identify and roll back this exact import,
  // AND so Phase 2 rollback can wipe just this batch's rows on a
  // mid-batch failure. Pre-existing positions are not stamped — undo
  // only deletes rows that were freshly created in this call.
  const importBatchId = randomUUID();

  const required = ["symbol", "action", "contracts", "strike", "expiry", "premium"] as const;

  // Resolved plan rows from Phase 1 — Phase 2 consumes these to write.
  type OptionPlan = {
    input: TradeInput;
    symbol: string;
    broker: string;
    fillDate: string;
    expiry: string;
    // Resolved position id when one already exists (exact or fuzzy
    // match), or when an earlier item in this batch will create it.
    existingPositionId: string | null;
    // True when this row is the FIRST OPEN for a new (symbol, strike,
    // expiry, broker) in this batch — Phase 2 will create the position.
    createsNewPosition: boolean;
    // Key for in-batch dedup so later items can reuse a position
    // created earlier in the same batch.
    keyForBatch: string;
  };
  type StockPlan = {
    input: StockTradeInput;
    symbol: string;
    broker: string;
    date: string;
    stockRowId: string;
    currentShares: number;
    shares: number;
    price: number;
    costBasis: number;
    stockPnl: number;
    prevRealized: number;
    newRealized: number;
    remainingShares: number;
    isFullClose: boolean;
    prevNotes: string | null;
  };

  // ============================================================
  // PHASE 1 — validate all trades. No writes.
  // ============================================================
  const optionPlans: OptionPlan[] = [];
  const inBatchNewPositionKeys = new Set<string>();

  for (const input of items) {
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

    const symbol = input.symbol.toUpperCase();
    const broker = normalizeBroker(input.broker);
    const rawFillDate = input.timePlaced ?? input.trade_date ?? null;
    const fillDate = rawFillDate ? toPstDate(rawFillDate, sourceTimezone) : todayPst();

    // Reject future fill dates. closed_date is derived from
    // max(close fill_date) downstream, so a stray future date here
    // permanently corrupts the position's closed_date — see the
    // SHOP/PLTR/DUOL 2026-05-26 incident.
    const todayP = todayPst();
    if (fillDate > todayP) {
      errors.push(
        `${symbol}: fill date ${fillDate} is in the future — check the date entered`,
      );
      continue;
    }

    const { normalized: expiry, wasWeekend } = normalizeExpiryToWeekday(input.expiry);
    if (wasWeekend) {
      console.warn(
        `[bulk-create] ${symbol}: normalized weekend expiry ${input.expiry} → ${expiry}`,
      );
    }

    // Exact match on (symbol, strike, expiry, broker) is the happy path.
    // For close fills, fall back to a fuzzy match on (symbol, strike,
    // broker, status='open') and pick the nearest expiry — the parser
    // may have read the date a day or two off and a brand-new "open"
    // position from a close fill would mint a phantom row with negative
    // remaining contracts.
    const { data: findData, error: fErr } = await supabase
      .from("positions")
      .select("id,expiry")
      .eq("symbol", symbol)
      .eq("strike", input.strike)
      .eq("expiry", expiry)
      .eq("broker", broker)
      .limit(1);
    if (fErr) {
      errors.push(`${input.symbol}: find failed — ${fErr.message}`);
      continue;
    }
    let existing = (findData ?? []) as Array<{ id: string; expiry: string }>;

    if (existing.length === 0 && input.action === "close") {
      const { data: openCandidatesRaw, error: cErr } = await supabase
        .from("positions")
        .select("id,expiry")
        .eq("symbol", symbol)
        .eq("strike", input.strike)
        .eq("broker", broker)
        .eq("status", "open");
      if (cErr) {
        errors.push(`${input.symbol}: close-match find failed — ${cErr.message}`);
        continue;
      }
      const candidates = (openCandidatesRaw ?? []) as Array<{ id: string; expiry: string }>;
      if (candidates.length > 0) {
        const targetMs = new Date(expiry + "T00:00:00Z").getTime();
        const nearest = candidates.reduce((best, c) => {
          const cMs = new Date(c.expiry + "T00:00:00Z").getTime();
          const bMs = new Date(best.expiry + "T00:00:00Z").getTime();
          return Math.abs(cMs - targetMs) < Math.abs(bMs - targetMs) ? c : best;
        });
        if (nearest.expiry !== expiry) {
          console.warn(
            `[bulk-create] ${symbol} close fill expiry ${expiry} routed to open position with expiry ${nearest.expiry}`,
          );
        }
        existing = [nearest];
      }
    }

    const keyForBatch = `${symbol}|${input.strike}|${expiry}|${broker}|${input.optionType ?? "put"}`;
    let existingPositionId: string | null = null;
    let createsNewPosition = false;

    if (existing.length > 0) {
      existingPositionId = existing[0].id;
    } else if (input.action === "close") {
      errors.push(
        `${symbol}: close fill found no matching open position (strike=${input.strike}, broker=${broker}, expiry=${expiry})`,
      );
      continue;
    } else if (inBatchNewPositionKeys.has(keyForBatch)) {
      // An earlier OPEN in this same batch will create the position;
      // this row will reuse it in Phase 2.
      existingPositionId = null;
      createsNewPosition = false;
    } else {
      // First OPEN for this key in this batch — Phase 2 will create.
      inBatchNewPositionKeys.add(keyForBatch);
      createsNewPosition = true;
    }

    optionPlans.push({
      input,
      symbol,
      broker,
      fillDate,
      expiry,
      existingPositionId,
      createsNewPosition,
      keyForBatch,
    });
  }

  // ---- Phase 1 stock validation ----
  const stockPlans: StockPlan[] = [];
  for (const s of stockInputs) {
    const symbol =
      typeof s.symbol === "string" ? s.symbol.trim().toUpperCase() : "";
    const broker = normalizeBroker(s.broker);
    const shares = Number(s.shares);
    const price = Number(s.price);
    const rawDate =
      typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date)
        ? s.date
        : null;
    const date = rawDate ? toPstDate(rawDate, sourceTimezone) : todayPst();

    if (s.action !== "sell") {
      errors.push(`stock ${symbol || "?"}: only action='sell' is supported`);
      continue;
    }
    if (!symbol) {
      errors.push(`stock ?: missing symbol`);
      continue;
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      errors.push(`stock ${symbol}: shares must be > 0`);
      continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push(`stock ${symbol}: price must be ≥ 0`);
      continue;
    }
    const todayPForStock = todayPst();
    if (date > todayPForStock) {
      errors.push(
        `stock ${symbol}: fill date ${date} is in the future — check the date entered`,
      );
      continue;
    }

    const lookup = await supabase
      .from("positions")
      .select(
        "id,symbol,total_contracts,entry_stock_price,position_type,status,realized_pnl,notes",
      )
      .eq("symbol", symbol)
      .eq("broker", broker)
      .eq("position_type", "stock_long")
      .eq("status", "open")
      .limit(1);
    if (lookup.error) {
      errors.push(`stock ${symbol}: lookup failed — ${lookup.error.message}`);
      continue;
    }
    const stockRow = ((lookup.data ?? []) as Array<{
      id: string;
      symbol: string;
      total_contracts: number;
      entry_stock_price: number | null;
      status: string;
      realized_pnl: number | null;
      notes: string | null;
    }>)[0];
    if (!stockRow) {
      errors.push(
        `stock ${symbol}: no open stock_long position for broker=${broker}`,
      );
      continue;
    }

    const currentShares = Number(stockRow.total_contracts ?? 0);
    if (shares > currentShares) {
      errors.push(
        `stock ${symbol}: tried to sell ${shares} shares but only ${currentShares} remaining`,
      );
      continue;
    }
    const costBasis =
      stockRow.entry_stock_price !== null
        ? Number(stockRow.entry_stock_price)
        : 0;
    const stockPnl = Math.round((price - costBasis) * shares * 100) / 100;
    const prevRealized = Number(stockRow.realized_pnl ?? 0) || 0;
    const newRealized = Math.round((prevRealized + stockPnl) * 100) / 100;
    const remainingShares = currentShares - shares;
    const isFullClose = remainingShares === 0;

    stockPlans.push({
      input: s,
      symbol,
      broker,
      date,
      stockRowId: stockRow.id,
      currentShares,
      shares,
      price,
      costBasis,
      stockPnl,
      prevRealized,
      newRealized,
      remainingShares,
      isFullClose,
      prevNotes: stockRow.notes,
    });
  }

  // Phase 1 gate — any error means zero writes happen.
  if (errors.length > 0) {
    console.log(
      `[bulk-create] PHASE 1 REJECTED — ${errors.length} validation error(s), no writes performed`,
    );
    for (const err of errors) {
      console.log(`[bulk-create] PHASE 1 ERROR: ${err}`);
    }
    return NextResponse.json(
      {
        positions_created: 0,
        positions_updated: 0,
        fills_inserted: 0,
        stocks_closed: 0,
        stocks_partial: 0,
        errors,
      },
      { status: 422 },
    );
  }

  // ============================================================
  // PHASE 2 — execute all inserts. On any failure, roll back this
  // batch and recompute aggregates on pre-existing positions we
  // touched so the DB ends up exactly where it started.
  // ============================================================

  // Track the writes so the rollback path knows what to delete /
  // recompute. New positions are stamped with importBatchId, so the
  // rollback can wipe them with a single .eq() — but we also keep
  // the in-memory id list for the success-path response counts.
  const positionsCreatedIds: string[] = [];
  // pos id → key, for in-batch dedup so subsequent opens of the same
  // (symbol, strike, expiry, broker) reuse the newly-created id.
  const newPosIdByKey = new Map<string, string>();
  const touchedPreExistingIds = new Set<string>();
  // For Phase 2b side-effect resolution (the close-snapshot path
  // needs to know which fills are actually new closes today).
  const optionFillRecords: Array<{
    plan: OptionPlan;
    positionId: string;
  }> = [];
  let fillsInserted = 0;
  let stocksClosed = 0;
  let stocksPartial = 0;

  async function rollback(reason: string): Promise<NextResponse> {
    console.error(
      `[bulk-create] PHASE 2 ROLLBACK (batch ${importBatchId}): ${reason}`,
    );
    // 1. Delete every fill stamped with this batch (FK before positions).
    const fDel = await supabase
      .from("fills")
      .delete()
      .eq("import_batch_id", importBatchId);
    if (fDel.error) {
      console.error(
        `[bulk-create] rollback: fills delete failed — ${fDel.error.message}`,
      );
    }
    // 2. Delete every position freshly created by this batch.
    const pDel = await supabase
      .from("positions")
      .delete()
      .eq("import_batch_id", importBatchId);
    if (pDel.error) {
      console.error(
        `[bulk-create] rollback: positions delete failed — ${pDel.error.message}`,
      );
    }
    // 3. Recompute aggregates for any pre-existing positions we
    //    updated during Phase 2. Their pre-batch fill set is exactly
    //    what remains after step 1, so recomputing yields the
    //    pre-batch state.
    for (const id of Array.from(touchedPreExistingIds)) {
      try {
        const { data: remainingRaw } = await supabase
          .from("fills")
          .select("fill_type, contracts, premium, fill_date")
          .eq("position_id", id);
        const remainingFills = (remainingRaw ?? []) as Fill[];
        const remaining = remainingContracts(remainingFills);
        const totalOpened = remainingFills
          .filter((f) => f.fill_type === "open")
          .reduce((s, f) => s + f.contracts, 0);
        const sold = avgPremiumSold(remainingFills);
        const status: "open" | "closed" =
          remaining === 0 && totalOpened > 0 ? "closed" : "open";
        const closedDate =
          status === "closed"
            ? remainingFills
                .filter((f) => f.fill_type === "close")
                .map((f) => f.fill_date)
                .sort()
                .pop() ?? null
            : null;
        const pnl = realizedPnl(remainingFills);
        await supabase
          .from("positions")
          .update({
            total_contracts: totalOpened,
            avg_premium_sold: totalOpened > 0 ? sold : null,
            status,
            closed_date: closedDate,
            realized_pnl: pnl,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
      } catch (e) {
        console.error(
          `[bulk-create] rollback: recompute failed for ${id}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return NextResponse.json(
      {
        positions_created: 0,
        positions_updated: 0,
        fills_inserted: 0,
        stocks_closed: 0,
        stocks_partial: 0,
        errors: [`Import rolled back — ${reason}`],
      },
      { status: 500 },
    );
  }

  // ---- Phase 2a — options: create positions, insert fills, recompute ----
  try {
    for (const plan of optionPlans) {
      const { input, symbol, broker, fillDate, expiry, keyForBatch } = plan;
      let positionId: string;
      if (plan.existingPositionId) {
        positionId = plan.existingPositionId;
        touchedPreExistingIds.add(positionId);
      } else if (newPosIdByKey.has(keyForBatch)) {
        positionId = newPosIdByKey.get(keyForBatch) as string;
      } else if (plan.createsNewPosition) {
        const { data: insertedRaw, error: iErr } = await supabase
          .from("positions")
          .insert({
            symbol,
            strike: input.strike,
            expiry,
            option_type: input.optionType ?? "put",
            broker,
            total_contracts: 0,
            avg_premium_sold: null,
            status: "open",
            opened_date: fillDate,
            notes: input.notes ?? null,
            import_batch_id: importBatchId,
          })
          .select()
          .single();
        const inserted = insertedRaw as PositionRow | null;
        if (iErr || !inserted) {
          throw new Error(
            `${input.symbol}: create position failed — ${iErr?.message ?? "unknown"}`,
          );
        }
        positionId = inserted.id;
        positionsCreatedIds.push(positionId);
        newPosIdByKey.set(keyForBatch, positionId);
      } else {
        // Shouldn't reach here — Phase 1 marks the first open of a new
        // (symbol, strike, expiry, broker) as createsNewPosition. A
        // later one in the same batch reuses the id from newPosIdByKey.
        throw new Error(
          `${symbol}: internal — could not resolve position id in Phase 2`,
        );
      }

      // Insert the fill.
      const { error: fillErr } = await supabase.from("fills").insert({
        position_id: positionId,
        fill_type: input.action,
        contracts: input.contracts,
        premium: input.premium,
        fill_date: fillDate,
        fill_time: new Date().toISOString(),
        import_batch_id: importBatchId,
      });
      if (fillErr) {
        throw new Error(`${input.symbol}: fill insert failed — ${fillErr.message}`);
      }
      fillsInserted += 1;
      optionFillRecords.push({ plan, positionId });

      // Recompute aggregates from the full fill set on this position.
      const { data: allFillsRaw, error: afErr } = await supabase
        .from("fills")
        .select("fill_type, contracts, premium, fill_date")
        .eq("position_id", positionId);
      if (afErr) {
        throw new Error(`${input.symbol}: refetch fills failed — ${afErr.message}`);
      }
      const fills = (allFillsRaw ?? []) as Fill[];
      const remaining = remainingContracts(fills);
      const totalOpened = fills
        .filter((f) => f.fill_type === "open")
        .reduce((s, f) => s + f.contracts, 0);
      const sold = avgPremiumSold(fills);
      const status: "open" | "closed" =
        remaining === 0 && totalOpened > 0 ? "closed" : "open";
      const closedDate =
        status === "closed"
          ? fills
              .filter((f) => f.fill_type === "close")
              .map((f) => f.fill_date)
              .sort()
              .pop() ?? null
          : null;
      const pnl = realizedPnl(fills);

      const { error: uErr } = await supabase
        .from("positions")
        .update({
          total_contracts: totalOpened,
          avg_premium_sold: totalOpened > 0 ? sold : null,
          status,
          closed_date: closedDate,
          realized_pnl: pnl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", positionId);
      if (uErr) {
        throw new Error(`${input.symbol}: position update failed — ${uErr.message}`);
      }
    }

    // ---- Phase 2a — stocks: insert fills, update positions ----
    for (const sp of stockPlans) {
      const fillInsert = await supabase.from("fills").insert({
        position_id: sp.stockRowId,
        fill_type: "close",
        contracts: sp.shares,
        premium: sp.price,
        fill_date: sp.date,
        fill_time: new Date().toISOString(),
        import_batch_id: importBatchId,
      });
      if (fillInsert.error) {
        throw new Error(
          `stock ${sp.symbol}: fill insert failed — ${fillInsert.error.message}`,
        );
      }
      fillsInserted += 1;
      touchedPreExistingIds.add(sp.stockRowId);

      const noteAdd = `Sold ${sp.shares} @ $${sp.price.toFixed(2)} on ${sp.date}. Stock P&L: ${sp.stockPnl >= 0 ? "+" : ""}$${sp.stockPnl.toFixed(2)}.`;
      const notes = sp.prevNotes ? `${sp.prevNotes} | ${noteAdd}` : noteAdd;
      const update = await supabase
        .from("positions")
        .update({
          total_contracts: sp.remainingShares,
          realized_pnl: sp.newRealized,
          status: sp.isFullClose ? "closed" : "open",
          closed_date: sp.isFullClose ? sp.date : null,
          notes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sp.stockRowId);
      if (update.error) {
        throw new Error(
          `stock ${sp.symbol}: position update failed — ${update.error.message}`,
        );
      }
      if (sp.isFullClose) stocksClosed += 1;
      else stocksPartial += 1;
    }
  } catch (e) {
    return rollback(e instanceof Error ? e.message : "unknown insert failure");
  }

  // ============================================================
  // PHASE 2b — best-effort side effects. Failures here are logged
  // but don't roll back the import. These are observational records
  // (snapshots, analytics grades, post-earnings outcomes), not the
  // trades themselves.
  // ============================================================
  for (const rec of optionFillRecords) {
    const { plan, positionId } = rec;
    const { input, symbol, fillDate } = plan;

    // Close-time snapshot — only when the close fill is dated today
    // (live IV/delta/theta from the chain). Historical backfills skip.
    if (input.action === "close" && fillDate === todayIso()) {
      try {
        const { data: posRow } = await supabase
          .from("positions")
          .select(
            "id, symbol, strike, expiry, avg_premium_sold, opened_date, entry_stock_price, entry_em_pct",
          )
          .eq("id", positionId)
          .single();
        const position = posRow as {
          id: string;
          symbol: string;
          strike: number;
          expiry: string;
          avg_premium_sold: number | null;
          opened_date: string | null;
          entry_stock_price: number | null;
          entry_em_pct: number | null;
        } | null;
        if (position) {
          const { data: preFillsRaw } = await supabase
            .from("fills")
            .select("fill_type, contracts, premium, fill_date")
            .eq("position_id", positionId);
          const preFills = (preFillsRaw ?? []) as Fill[];
          const chain = await fetchChainWideSafe(position.symbol, position.expiry);
          const snapshotRow = buildSnapshotRow(position, chain, preFills, {
            nowIso: new Date().toISOString(),
            closeSnapshot: true,
          });
          const { error: sErr } = await supabase
            .from("position_snapshots")
            .insert(snapshotRow);
          if (sErr) {
            console.warn(
              `[bulk-create] close snapshot insert failed for ${input.symbol}: ${sErr.message}`,
            );
          }
        }
      } catch (e) {
        console.warn(
          `[bulk-create] close snapshot capture failed for ${input.symbol}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // Entry-grades merge from tracked_tickers — only on OPEN fills,
    // only when the position doesn't already carry grades.
    if (input.action === "open") {
      try {
        const { data: posData } = await supabase
          .from("positions")
          .select("entry_crush_grade")
          .eq("id", positionId)
          .single();
        const already = (posData as { entry_crush_grade?: string | null } | null)?.entry_crush_grade;
        if (!already) {
          const fillMs = new Date(fillDate + "T00:00:00Z").getTime();
          const prevDay = new Date(fillMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const { data: trackedRaw } = await supabase
            .from("tracked_tickers")
            .select("*")
            .eq("symbol", symbol)
            .eq("expiry", plan.expiry)
            .in("screened_date", [fillDate, prevDay])
            .order("screened_date", { ascending: false })
            .limit(1);
          const match = ((trackedRaw ?? []) as Array<Record<string, unknown>>)[0];
          if (match) {
            const { error: mErr } = await supabase
              .from("positions")
              .update({
                entry_crush_grade: match.entry_crush_grade ?? null,
                entry_opportunity_grade: match.entry_opportunity_grade ?? null,
                entry_final_grade: match.entry_final_grade ?? null,
                entry_iv_edge: match.entry_iv_edge ?? null,
                entry_em_pct: match.entry_em_pct ?? null,
                entry_vix: match.entry_vix ?? null,
                entry_news_summary: match.entry_news_summary ?? null,
                entry_stock_price: match.entry_stock_price ?? null,
              })
              .eq("id", positionId);
            if (mErr) {
              console.warn(
                `[bulk-create] merge tracked grades failed for ${input.symbol}: ${mErr.message}`,
              );
            }
          }
        }
      } catch (e) {
        console.warn(
          `[bulk-create] tracked-ticker merge failed for ${input.symbol}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // recordPositionOutcome — fires when this fill flipped the position
    // to closed. Refetch the live status rather than threading it out
    // of Phase 2a, which keeps Phase 2a's logic linear.
    if (input.action === "close") {
      try {
        const { data: pRow } = await supabase
          .from("positions")
          .select("status")
          .eq("id", positionId)
          .single();
        const status = (pRow as { status?: string } | null)?.status;
        if (status === "closed") {
          await recordPositionOutcome(positionId);
        }
      } catch (e) {
        console.warn(
          `[bulk-create] recordPositionOutcome(${positionId}) failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  const positionsCreated = positionsCreatedIds.length;
  const positionsUpdated = touchedPreExistingIds.size;

  console.log(
    `[bulk-create] OK batch=${importBatchId} options=${optionPlans.length} stocks=${stockPlans.length} positions_created=${positionsCreated} positions_updated=${positionsUpdated} fills_inserted=${fillsInserted} stocks_closed=${stocksClosed} stocks_partial=${stocksPartial}`,
  );

  return NextResponse.json({
    positions_created: positionsCreated,
    positions_updated: positionsUpdated,
    fills_inserted: fillsInserted,
    stocks_closed: stocksClosed,
    stocks_partial: stocksPartial,
    errors: [],
  });
}
