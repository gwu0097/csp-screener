// READ-ONLY validation of the surviving write-time date guard
// (PASS_2D/2E): isQuarterEndDate. The cadence guard (checkCadence) was
// removed in PASS_2E — see lib/encyclopedia.ts for why (11.4%+
// false-positive rate at default tolerance, missed both motivating
// cases). This script now only exercises the real exported
// isQuarterEndDate function.
import { isQuarterEndDate } from "@/lib/encyclopedia";

console.log("================ quarter-end guard ================\n");
const quarterEndCases = ["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"];
const nonQuarterEndCases = ["2026-07-29", "2026-04-24", "2025-05-08", "2026-02-05"];
let pass = 0;
let total = 0;
for (const d of quarterEndCases) {
  total++;
  const flagged = isQuarterEndDate(d);
  const ok = flagged === true;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  isQuarterEndDate(${d}) = ${flagged} (expect true — write-time guard rejects this as a trusted announcement date)`);
}
for (const d of nonQuarterEndCases) {
  total++;
  const flagged = isQuarterEndDate(d);
  const ok = flagged === false;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  isQuarterEndDate(${d}) = ${flagged} (expect false — real dates must NOT be rejected)`);
}
console.log(`\n${pass}/${total} passed.`);
if (pass !== total) process.exit(1);
