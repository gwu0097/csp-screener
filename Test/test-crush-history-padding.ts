// Verifies the 8-quarter-slot padding math added to
// components/crush-history-table.tsx. That file is a "use client"
// component (not importable standalone), so the helper functions and
// the padding loop are copied verbatim here to test in isolation —
// keep in sync with the component if either changes.
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

type Event = { earningsDate: string; qtrLabel: string; impliedMovePct: number | null };

const HISTORY_QUARTER_COUNT = 8;
function buildDisplayRows(realEvents: Event[], todayIso: string): Event[] {
  const byQuarter = new Map<string, Event>();
  for (const e of realEvents) {
    const label = quarterLabel(e.earningsDate);
    if (!byQuarter.has(label)) byQuarter.set(label, e);
  }
  const rows: Event[] = [];
  let cursor = quarterOfDate(todayIso);
  for (let i = 0; i < HISTORY_QUARTER_COUNT; i += 1) {
    const label = quarterYearLabel(cursor);
    const real = byQuarter.get(label);
    rows.push(
      real ?? {
        earningsDate: representativeDate(cursor),
        qtrLabel: label,
        impliedMovePct: null,
      },
    );
    cursor = previousQuarter(cursor);
  }
  return rows;
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

const TODAY = "2026-07-26";

// -------- Case 1: INTC's real 5 rows — 3 empty slots at the old end --------
{
  const intc: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1203 },
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.103 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.0931 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.092 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.085 },
  ];
  const rows = buildDisplayRows(intc, TODAY);
  const labels = rows.map((r) => quarterLabel(r.earningsDate));
  console.log("  INTC labels:", labels);
  check("exactly 8 rows", rows.length === 8);
  check(
    "labels are Q2 2026 -> Q3 2024, in order",
    JSON.stringify(labels) ===
      JSON.stringify(["Q2 2026", "Q1 2026", "Q4 2025", "Q3 2025", "Q2 2025", "Q1 2025", "Q4 2024", "Q3 2024"]),
  );
  check("first 5 are the real rows (non-null EM)", rows.slice(0, 5).every((r) => r.impliedMovePct !== null));
  check("last 3 are empty placeholders (null EM)", rows.slice(5).every((r) => r.impliedMovePct === null));
}

// -------- Case 2: genuinely 8 fetchable quarters — no padding, no dupes --------
{
  const eight: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2026-01-22", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-04-24", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2025-01-23", qtrLabel: "", impliedMovePct: 0.1 },
    { earningsDate: "2024-10-24", qtrLabel: "", impliedMovePct: 0.1 },
  ];
  const rows = buildDisplayRows(eight, TODAY);
  const labels = rows.map((r) => quarterLabel(r.earningsDate));
  console.log("  8-real labels:", labels);
  check("exactly 8 rows, no double-counting", rows.length === 8);
  check("all 8 are real (non-null EM), none synthetic", rows.every((r) => r.impliedMovePct !== null));
  check("no duplicate quarter labels", new Set(labels).size === 8);
  check(
    "matches expected 8-quarter span exactly",
    JSON.stringify(labels) ===
      JSON.stringify(["Q2 2026", "Q1 2026", "Q4 2025", "Q3 2025", "Q2 2025", "Q1 2025", "Q4 2024", "Q3 2024"]),
  );
}

// -------- Case 3: gap in the MIDDLE (not just the old end) --------
{
  const gapped: Event[] = [
    { earningsDate: "2026-07-23", qtrLabel: "", impliedMovePct: 0.1 }, // Q2 2026
    { earningsDate: "2026-04-23", qtrLabel: "", impliedMovePct: 0.1 }, // Q1 2026
    // Q4 2025 missing
    { earningsDate: "2025-10-23", qtrLabel: "", impliedMovePct: 0.1 }, // Q3 2025
    { earningsDate: "2025-07-24", qtrLabel: "", impliedMovePct: 0.1 }, // Q2 2025
    { earningsDate: "2025-04-24", qtrLabel: "", impliedMovePct: 0.1 }, // Q1 2025
    { earningsDate: "2025-01-23", qtrLabel: "", impliedMovePct: 0.1 }, // Q4 2024
    { earningsDate: "2024-10-24", qtrLabel: "", impliedMovePct: 0.1 }, // Q3 2024
  ];
  const rows = buildDisplayRows(gapped, TODAY);
  const labels = rows.map((r) => quarterLabel(r.earningsDate));
  console.log("  gapped-middle labels:", labels);
  check("exactly 8 rows even with a mid-window gap", rows.length === 8);
  check(
    "Q4 2025 (index 2) is the empty synthetic slot",
    labels[2] === "Q4 2025" && rows[2].impliedMovePct === null,
  );
  check(
    "every other slot is real",
    rows.filter((_, i) => i !== 2).every((r) => r.impliedMovePct !== null),
  );
}

// -------- Case 4: representativeDate round-trips for every quarter of a year --------
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
