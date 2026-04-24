import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  remainingContracts,
  avgPremiumSold,
  realizedPnl,
  type Fill,
  type PositionRow,
} from "@/lib/positions";
import { buildSnapshotRow, fetchChainSafe } from "@/lib/snapshots";
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
  timePlaced?: string; // YYYY-MM-DD preferred from ToS "Time Placed"
  trade_date?: string;
  notes?: string | null;
};

type BulkBody = { trades?: TradeInput[] };

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

  // Opens first within the batch — that way a position exists before any
  // close fill in the same batch tries to attach to it.
  const items = [...itemsRaw].sort((a, b) => {
    const aw = a.action === "open" ? 0 : a.action === "close" ? 1 : 2;
    const bw = b.action === "open" ? 0 : b.action === "close" ? 1 : 2;
    return aw - bw;
  });

  const supabase = createServerClient();
  const errors: string[] = [];
  let positionsCreated = 0;
  const positionsTouched = new Set<string>();
  let fillsInserted = 0;

  const required = ["symbol", "action", "contracts", "strike", "expiry", "premium"] as const;

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
    const fillDate = input.timePlaced ?? input.trade_date ?? todayIso();

    const { normalized: expiry, wasWeekend } = normalizeExpiryToWeekday(input.expiry);
    if (wasWeekend) {
      console.warn(
        `[bulk-create] ${symbol}: normalized weekend expiry ${input.expiry} → ${expiry}`,
      );
    }

    try {
      // 1. Find or create the position.
      const { data: findData, error: fErr } = await supabase
        .from("positions")
        .select("*")
        .eq("symbol", symbol)
        .eq("strike", input.strike)
        .eq("expiry", expiry)
        .eq("broker", broker)
        .limit(1);
      if (fErr) {
        errors.push(`${input.symbol}: find failed — ${fErr.message}`);
        continue;
      }
      const existing = (findData ?? []) as PositionRow[];

      let positionId: string;
      if (existing.length > 0) {
        positionId = existing[0].id;
      } else {
        // New position. total_contracts/avg_premium_sold get set to real
        // values by the recompute step below — we just need valid defaults.
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
          })
          .select()
          .single();
        const inserted = insertedRaw as PositionRow | null;
        if (iErr || !inserted) {
          errors.push(`${input.symbol}: create position failed — ${iErr?.message ?? "unknown"}`);
          continue;
        }
        positionId = inserted.id;
        positionsCreated += 1;
      }

      // 2. Insert the fill.
      const { error: fillErr } = await supabase.from("fills").insert({
        position_id: positionId,
        fill_type: input.action,
        contracts: input.contracts,
        premium: input.premium,
        fill_date: fillDate,
        fill_time: new Date().toISOString(),
      });
      if (fillErr) {
        errors.push(`${input.symbol}: fill insert failed — ${fillErr.message}`);
        continue;
      }
      fillsInserted += 1;
      positionsTouched.add(positionId);

      // 2a. Close-time snapshot. Fires when a close fill is dated today,
      // regardless of entry point (position-card Close button OR same-day
      // screenshot upload). Captures live market conditions — IV/delta/
      // theta from the chain, move-since-entry, pct-premium-remaining —
      // tagged close_snapshot=true so analytics can separate final
      // readings from intraday ones. Historical backfills (fill_date in
      // the past) skip this to avoid writing "now" Greeks onto old
      // trades. Failures are logged but don't block the close fill.
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
            const chain = await fetchChainSafe(position.symbol);
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

      // 2b. If this is an OPEN fill and the position doesn't yet have
      // entry grades, try to find a tracked_tickers row captured during
      // a prior Run Analysis and merge its entry_* fields in. Checks the
      // same day as the fill OR the previous day (BMO trades are filed
      // under their entry morning but were tracked the night before).
      if (input.action === "open") {
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
            .eq("expiry", expiry)
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
              errors.push(`${input.symbol}: merge tracked grades failed — ${mErr.message}`);
            }
          }
        }
      }

      // 3. Recompute position aggregates from the full fill set.
      const { data: allFillsRaw, error: afErr } = await supabase
        .from("fills")
        .select("fill_type, contracts, premium, fill_date")
        .eq("position_id", positionId);
      if (afErr) {
        errors.push(`${input.symbol}: refetch fills failed — ${afErr.message}`);
        continue;
      }
      const fills = (allFillsRaw ?? []) as Fill[];
      const remaining = remainingContracts(fills);
      const totalOpened = fills
        .filter((f) => f.fill_type === "open")
        .reduce((s, f) => s + f.contracts, 0);
      const sold = avgPremiumSold(fills);
      const status: "open" | "closed" = remaining === 0 && totalOpened > 0 ? "closed" : "open";
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
        errors.push(`${input.symbol}: position update failed — ${uErr.message}`);
      }

      // If this fill flipped the position to closed, record the outcome
      // against the most recent post-earnings recommendation. Silent
      // no-op when no rec exists for this position.
      if (status === "closed") {
        try {
          await recordPositionOutcome(positionId);
        } catch (e) {
          console.warn(
            `[bulk-create] recordPositionOutcome(${positionId}) failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    } catch (e) {
      errors.push(
        `${input.symbol}: ${e instanceof Error ? e.message : "insert failed"}`,
      );
    }
  }

  console.log(
    `[bulk-create] items=${items.length} positions_created=${positionsCreated} positions_updated=${positionsTouched.size - positionsCreated} fills_inserted=${fillsInserted} errors=${errors.length}`,
  );

  return NextResponse.json({
    positions_created: positionsCreated,
    positions_updated: Math.max(0, positionsTouched.size - positionsCreated),
    fills_inserted: fillsInserted,
    errors,
  });
}
