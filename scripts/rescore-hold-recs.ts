// One-time re-score of the 4 HOLD recommendations whose
// was_system_aligned stayed null under the pre-fix scoring logic
// (lib/post-earnings.ts had no CLOSED_EARLY branch under HOLD). Calls
// the same recordPositionOutcome() the live pipeline uses — idempotent,
// no new logic here, just re-triggering it for known-affected rows.
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

const POSITION_IDS = [
  "9bf51c54-2871-4a4f-9e74-76751c844a37", // SPGI
  "0cb7a254-2395-4a26-8620-5ea1827422bb", // SPGI
  "eeab9155-c85a-4172-9b35-3483083bc7fd", // TTWO
  "ac98aa87-6311-40b1-87a1-cc85aedf3f21", // HIMS
];

async function main() {
  loadEnvLocal();
  const { recordPositionOutcome } = await import("../lib/post-earnings");
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();

  for (const id of POSITION_IDS) {
    await recordPositionOutcome(id);
  }

  const recsRes = await sb
    .from("post_earnings_recommendations")
    .select("id,position_id,recommendation,position_outcome,was_system_aligned")
    .in("position_id", POSITION_IDS);
  console.log(JSON.stringify(recsRes.data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
