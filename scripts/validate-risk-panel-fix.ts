// Validates the two collateral-calculation changes against real Q3
// 2026 data: (1) end-of-day-snapshot semantics instead of inclusive-
// through-closed_date, (2) covered_calls excluded entirely. Reports
// before/after per broker and combined.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

type Row = {
  broker: string | null;
  strike: string;
  total_contracts: number;
  opened_date: string | null;
  closed_date: string | null;
  status: string;
  position_type: string | null;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type RiskLeg = { opened_date: string; closed_date: string | null; strike: number; total_contracts: number };

// OLD: inclusive through closed_date.
function seriesOld(legs: RiskLeg[], fromDate: string, toDate: string) {
  const deltas = new Map<string, number>();
  for (const leg of legs) {
    const capital = leg.strike * leg.total_contracts * 100;
    if (!Number.isFinite(capital) || capital <= 0) continue;
    const legEnd = leg.closed_date ?? toDate;
    if (leg.opened_date > toDate || legEnd < fromDate) continue;
    const start = leg.opened_date < fromDate ? fromDate : leg.opened_date;
    const cappedEnd = legEnd > toDate ? toDate : legEnd;
    const endExclusive = addDaysIso(cappedEnd, 1);
    deltas.set(start, (deltas.get(start) ?? 0) + capital);
    deltas.set(endExclusive, (deltas.get(endExclusive) ?? 0) - capital);
  }
  return walk(deltas, fromDate, toDate);
}

// NEW: end-of-day snapshot — half-open [opened_date, closed_date).
function seriesNew(legs: RiskLeg[], fromDate: string, toDate: string) {
  const deltas = new Map<string, number>();
  for (const leg of legs) {
    const capital = leg.strike * leg.total_contracts * 100;
    if (!Number.isFinite(capital) || capital <= 0) continue;
    const rawEnd = leg.closed_date;
    if (rawEnd !== null && rawEnd <= leg.opened_date) continue;
    if (leg.opened_date > toDate) continue;
    if (rawEnd !== null && rawEnd <= fromDate) continue;
    const start = leg.opened_date < fromDate ? fromDate : leg.opened_date;
    deltas.set(start, (deltas.get(start) ?? 0) + capital);
    if (rawEnd !== null && rawEnd <= toDate) {
      deltas.set(rawEnd, (deltas.get(rawEnd) ?? 0) - capital);
    }
  }
  return walk(deltas, fromDate, toDate);
}

function walk(deltas: Map<string, number>, fromDate: string, toDate: string) {
  const sortedDeltaDates = Array.from(deltas.keys()).sort();
  const series: Array<{ date: string; collateral: number }> = [];
  let running = 0;
  let di = 0;
  for (let d = fromDate; d <= toDate; d = addDaysIso(d, 1)) {
    while (di < sortedDeltaDates.length && sortedDeltaDates[di] <= d) {
      running += deltas.get(sortedDeltaDates[di]) ?? 0;
      di++;
    }
    series.push({ date: d, collateral: Math.round(running) });
  }
  return series;
}

function peakAndAvgOf(series: Array<{ date: string; collateral: number }>) {
  let peak = 0;
  let date: string | null = null;
  let sum = 0;
  for (const pt of series) {
    sum += pt.collateral;
    if (pt.collateral > peak) {
      peak = pt.collateral;
      date = pt.date;
    }
  }
  const avg = series.length > 0 ? sum / series.length : 0;
  return { peak, date, avg };
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  const from = "2026-07-01";
  const to = "2026-09-30";

  const closedRes = await sb
    .from("positions")
    .select("broker,strike,total_contracts,opened_date,closed_date,status,position_type")
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"]);
  const closedRows = ((closedRes.data ?? []) as Row[]).filter(
    (p) => p.position_type !== "stock_long" && p.position_type !== "stock_short",
  );
  const openRes = await sb
    .from("positions")
    .select("broker,strike,total_contracts,opened_date,closed_date,status,position_type")
    .eq("user_id", userId)
    .eq("status", "open");
  const openRows = ((openRes.data ?? []) as Row[]).filter(
    (p) => p.position_type !== "stock_long" && p.position_type !== "stock_short",
  );
  const allRows = [...closedRows, ...openRows];

  function legsFor(broker: string | null, excludeCoveredCalls: boolean): RiskLeg[] {
    return allRows
      .filter((r) => (broker === null ? true : (r.broker ?? "unknown") === broker))
      .filter((r) => !excludeCoveredCalls || r.broker !== "covered_calls")
      .filter((r) => r.opened_date !== null)
      .map((r) => ({
        opened_date: r.opened_date as string,
        closed_date: r.closed_date,
        strike: Number(r.strike),
        total_contracts: Number(r.total_contracts),
      }));
  }

  const brokers = Array.from(new Set(allRows.map((r) => r.broker ?? "unknown"))).sort();

  function report(label: string, broker: string | null) {
    // BEFORE = old inclusive rule, covered_calls included (production
    // behavior prior to this change).
    const before = peakAndAvgOf(seriesOld(legsFor(broker, false), from, to));
    // AFTER = end-of-day snapshot, covered_calls excluded (new
    // production behavior) — N/A when broker IS covered_calls.
    const isCoveredCallsOnly = broker === "covered_calls";
    const after = isCoveredCallsOnly
      ? null
      : peakAndAvgOf(seriesNew(legsFor(broker, true), from, to));
    console.log(`\n${label}`);
    console.log(
      `  BEFORE: peak $${before.peak.toLocaleString()} on ${before.date}, avg $${Math.round(before.avg).toLocaleString()}`,
    );
    if (after === null) {
      console.log(`  AFTER:  N/A (covered_calls — no collateral figure applies)`);
    } else {
      console.log(
        `  AFTER:  peak $${after.peak.toLocaleString()} on ${after.date}, avg $${Math.round(after.avg).toLocaleString()}`,
      );
      const pct = before.peak > 0 ? ((before.peak - after.peak) / before.peak) * 100 : 0;
      console.log(`  change: ${after.peak - before.peak >= 0 ? "+" : ""}$${(after.peak - before.peak).toLocaleString()} (${pct >= 0 ? "-" : "+"}${Math.abs(pct).toFixed(1)}% vs before)`);
    }
  }

  report("Combined (all brokers)", null);
  for (const b of brokers) report(b, b);

  // Combined AFTER excluding covered_calls entirely (the real "All"
  // broker-filter view once this ships) vs the non-covered-call
  // account total the user wants to sanity-check against (~$1.2M).
  const afterCombinedNoCC = peakAndAvgOf(seriesNew(legsFor(null, true), from, to));
  console.log(`\n=== Combined AFTER, covered_calls excluded (the real "All" filter view) ===`);
  console.log(`peak $${afterCombinedNoCC.peak.toLocaleString()} on ${afterCombinedNoCC.date}, avg $${Math.round(afterCombinedNoCC.avg).toLocaleString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
