// Verifies the 8-quarter-slot padding + pinned-quarter dedup added to
// components/crush-history-table.tsx. That file is a "use client"
// component (not importable standalone), so the helper functions and
// the full sorted/pinned/displayRows pipeline are copied verbatim here
// to test in isolation — keep in sync with the component if either
// changes.
// Run: npx tsx Test/test-crush-history-padding.ts

function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

type QuarterYear = { q: 1 | 2 | 3 | 4; y: number };

function quarterOfDate(dateIso: string): QuarterYear {
  const [y, m] = dateIso.split("-").map(Number);
  if (m <= 3) return { q: 4, y: y - 1 };
  if (m <= 6) return { q: 1, y };
  if (m <= 9) return { q: 2, y };
  return { q: 3, y };
}

function quarterYearLabel(qy: QuarterYear): string {
  return `Q${qy.q} ${qy.y}`;
}

function previousQuarter(qy: QuarterYear): QuarterYear {
  return qy.q === 1 ? { q: 4, y: qy.y - 1 } : { q: (qy.q - 1) as 1 | 2 | 3, y: qy.y };
}

function representativeDate(qy: QuarterYear): string {
  const byQuarter: Record<1 | 2 | 3 | 4, { y: number; m: number }> = {
    1: { y: qy.y, m: 5 },
    2: { y: qy.y, m: 8 },
    3: { y: qy.y, m: 11 },
    4: { y: qy.y + 1, m: 2 },
  };
  const { y, m } = byQuarter[qy.q];
  return `${y}-${String(m).padStart(2, "0")}-15`;
}

type Event = {
  earningsDate: string;
  qtrLabel: string;
  impliedMovePct: number | null;
};

const HISTORY_QUARTER_COUNT = 8;

// Full pipeline mirror: liveEvents -> upcoming (pinned) -> sorted
// (excludes pinned) -> displayRows (8 slots, skipping whichever one
// matches the pinned quarter by (year, quarter) identity).
function runPipeline(liveEvents: Event[], todayEarningsDate: string, todayIso: string) {
  const upcoming =
    liveEvents.find((e) => e.earningsDate === todayEarningsDate) ??
    liveEvents.find((e) => e.earningsDate >= todayIso) ??
    null;

  const sorted = liveEvents
    .filter((e) => e !== upcoming && e.earningsDate < todayIso)
    .sort((a, b) => b.earningsDate.localeCompare(a.earningsDate));

  const pinnedDate = todayEarningsDate || upcoming?.earningsDate || todayIso;
  const pinnedQY = quarterOfDate(pinnedDate);

  const byQuarter = new Map<string, Event>();
  for (const e of sorted) {
    const label = quarterLabel(e.earningsDate);
    if (!byQuarter.has(label)) byQuarter.set(label, e);
  }
  const displayRows: Event[] = [];
  let cursor = quarterOfDate(todayIso);
  for (let i = 0; i < HISTORY_QUARTER_COUNT; i += 1) {
    if (cursor.q !== pinnedQY.q || cursor.y !== pinnedQY.y) {
      const label = quarterYearLabel(cursor);
      const real = byQuarter.get(label);
      displayRows.push(
        real ?? {
          earningsDate: representativeDate(cursor),
          qtrLabel: label,
          impliedMovePct: null,
        },
      );
    }
    cursor = previousQuarter(cursor);
  }
  return { upcoming, sorted, pinnedQY, displayRows };
}

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}

const TODAY = "2026-07-27";

// -------- Case 1: INTC's real 5 rows — no pinned/upcoming context --------
// (isolated padding math only, matches the previous pass's check)
{
  const intc: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1203 },
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.103 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.0931 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.092 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.085 },
  ];
  // No live pinned context (todayEarningsDate irrelevant to this
  // symbol) — pinnedDate falls back to todayIso, whose quarter (Q2
  // 2026) IS INTC's own already-reported quarter, so this exercises
  // the exact same collapse as case 2 below via the todayIso fallback.
  const { displayRows } = runPipeline(intc, "", TODAY);
  const labels = displayRows.map((r) => quarterLabel(r.earningsDate));
  console.log("  INTC (no explicit todayEarningsDate) labels:", labels);
  check("7 historical rows + 1 pinned = 8 total quarters", displayRows.length === 7);
  check(
    "labels are Q1 2026 -> Q3 2024 (Q2 2026 covered by pinned, not duplicated)",
    JSON.stringify(labels) ===
      JSON.stringify(["Q1 2026", "Q4 2025", "Q3 2025", "Q2 2025", "Q1 2025", "Q4 2024", "Q3 2024"]),
  );
}

// -------- Case 2: INTC with real todayEarningsDate — newest quarter --------
// already reported, must show via the pinned row exactly once, not
// also as an empty generated row.
{
  const intc: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1203 },
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.103 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.0931 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.092 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.085 },
  ];
  const { upcoming, displayRows } = runPipeline(intc, "2026-07-23", TODAY);
  const labels = displayRows.map((r) => quarterLabel(r.earningsDate));
  console.log("  INTC (real todayEarningsDate) labels:", labels);
  check("upcoming/pinned merge picked up INTC's real Q2 2026 row", upcoming?.earningsDate === "2026-07-23");
  check("Q2 2026 does not appear in the historical rows", !labels.includes("Q2 2026"));
  check("no empty duplicate for Q2 2026", displayRows.every((r) => quarterLabel(r.earningsDate) !== "Q2 2026"));
  check("still 7 historical + 1 pinned = 8 total, no gaps", displayRows.length === 7);
}

// -------- Case 3: GLW — reports tomorrow, EM 11.0%, no fetched history yet --------
// This is the reported bug: the pinned "reports tomorrow" row and a
// generated empty Q2 2026 slot must collapse into one.
{
  // GLW has no earnings_history rows fetched yet at all — the "live"
  // upcoming row comes from the screener context (todayEarningsDate +
  // todayEmPct), not from liveEvents. liveEvents is empty.
  const glw: Event[] = [];
  const { displayRows } = runPipeline(glw, "2026-07-28", TODAY); // reports tomorrow
  const labels = displayRows.map((r) => quarterLabel(r.earningsDate));
  console.log("  GLW (reports tomorrow) labels:", labels);
  check("Q2 2026 does not appear as a generated slot", !labels.includes("Q2 2026"));
  check("7 empty historical slots, Q3 2025 through Q3 2024... i.e. Q1 2026 down", displayRows.length === 7);
  check(
    "labels are Q1 2026 -> Q3 2024",
    JSON.stringify(labels) ===
      JSON.stringify(["Q1 2026", "Q4 2025", "Q3 2025", "Q2 2025", "Q1 2025", "Q4 2024", "Q3 2024"]),
  );
}

// -------- Case 4: genuinely 8 fetchable quarters, no pinned overlap --------
// (todayEarningsDate is far in the future — e.g. next quarter's report
// not yet scheduled close to today — so nothing gets excluded)
{
  const eight: Event[] = [
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-04-24", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-01-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2024-10-24", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2024-07-25", qtrLabel: "", impliedMovePct: 0.1 },
  ];
  // Pinned quarter (from todayEarningsDate) is Q2 2026 — genuinely has
  // no fetched row yet (next report not out), so all 8 target quarters
  // Q2'26..Q3'24 should show: Q2'26 as an empty pinned row (not part of
  // displayRows), the other 7 as real rows.
  const { displayRows } = runPipeline(eight, "2026-07-28", TODAY);
  const labels = displayRows.map((r) => quarterLabel(r.earningsDate));
  console.log("  8-real (no Q2 2026 fetched yet) labels:", labels);
  check("7 real historical rows, no synthetic, no dupes", displayRows.length === 7);
  check("all 7 are real (non-null EM)", displayRows.every((r) => r.impliedMovePct !== null));
  check("no duplicate quarter labels", new Set(labels).size === 7);
}

// -------- Case 5: manual quarter still dedups correctly against slots --------
// A manually-backfilled OLD quarter (not the pinned one) must not
// produce a twin empty row alongside itself.
{
  const withManual: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1203 },
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.103 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.0931 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.092 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.085 },
    { earningsDate: "2025-05-15", qtrLabel: "Q1 2025", impliedMovePct: 0.09 }, // manual backfill
  ];
  const { displayRows } = runPipeline(withManual, "2026-07-23", TODAY);
  const labels = displayRows.map((r) => quarterLabel(r.earningsDate));
  const q1_2025_rows = displayRows.filter((r) => quarterLabel(r.earningsDate) === "Q1 2025");
  console.log("  manual-backfill labels:", labels);
  check("exactly one Q1 2025 row (the manual one), not a twin empty", q1_2025_rows.length === 1);
  check("that row carries the manual data, not null", q1_2025_rows[0]?.impliedMovePct === 0.09);
  check("7 historical rows total (Q2 2026 pinned, not duplicated)", displayRows.length === 7);
}

// -------- Case 6: representativeDate round-trips for every quarter --------
{
  for (const q of [1, 2, 3, 4] as const) {
    const qy: QuarterYear = { q, y: 2025 };
    const d = representativeDate(qy);
    const back = quarterLabel(d);
    check(`representativeDate(${quarterYearLabel(qy)}) = ${d} round-trips`, back === quarterYearLabel(qy));
  }
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
