// READ-ONLY validation of isT1SessionEligible (lib/earnings-capture.ts)
// against real known cases from this pass's audit. Exercises the REAL
// exported function, not a reimplementation. No DB access needed.
import { isT1SessionEligible } from "@/lib/earnings-capture";

const TODAY = "2026-07-30"; // matches this session's actual "today"

type Case = { label: string; earnings_date: string; timing: string | null; expect: boolean };

const cases: Case[] = [
  // BMO same-day — must stay eligible (GLW/UPS 2026-07-28 pattern,
  // captured same-session the whole time and correctly never contaminated).
  { label: "GLW-style BMO, same day as print", earnings_date: "2026-07-28", timing: "bmo", expect: true },
  { label: "UPS-style BMO, same day as print", earnings_date: "2026-07-28", timing: "bmo", expect: true },
  // AMC same-day — must now be REJECTED (the bug this fix closes).
  { label: "AMZN-style AMC, same day as print (today)", earnings_date: TODAY, timing: "amc", expect: false },
  { label: "CDNS-style AMC, same day as print (today)", earnings_date: TODAY, timing: "amc", expect: false },
  // AMC next session — must be eligible (CDNS's REAL earnings_date,
  // 2026-07-27, relative to TODAY=2026-07-30 — 3 sessions later,
  // comfortably eligible).
  { label: "CDNS-style AMC, sessions after print (real date)", earnings_date: "2026-07-27", timing: "amc", expect: true },
  { label: "AMC, one session after print", earnings_date: "2026-07-29", timing: "amc", expect: true },
  // unknown timing — treated as AMC (conservative).
  { label: "unknown timing, same day", earnings_date: TODAY, timing: "unknown", expect: false },
  { label: "unknown timing, next day", earnings_date: "2026-07-29", timing: "unknown", expect: true },
  { label: "null timing (legacy row), same day", earnings_date: TODAY, timing: null, expect: false },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = isT1SessionEligible({ earnings_date: c.earnings_date, timing: c.timing }, TODAY);
  const ok = got === c.expect;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(45)} expect=${c.expect} got=${got}`);
}
console.log(`\n${pass}/${cases.length} passed.`);
if (fail > 0) process.exit(1);
