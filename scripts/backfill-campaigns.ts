// Retroactive campaign-layer backfill over the whole account — resolves
// every existing trade chain to the earnings event it belongs to
// (lib/campaigns.ts) and stamps campaign_id on every member position.
//   npx tsx scripts/backfill-campaigns.ts            → dry run (counts only)
//   npx tsx scripts/backfill-campaigns.ts --apply    → persists
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

async function main() {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const { createServerClient } = await import("../lib/supabase");
  const { buildAndPersistCampaigns } = await import("../lib/campaigns");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";
  const sb = createServerClient();

  const symRes = await sb.from("positions").select("symbol").eq("user_id", userId);
  const symbols = Array.from(
    new Set(((symRes.data ?? []) as Array<{ symbol: string }>).map((r) => r.symbol.toUpperCase())),
  ).sort();
  console.log(`${symbols.length} distinct symbols for this user\n`);

  if (!apply) {
    console.log("DRY RUN — buildAndPersistCampaigns writes campaign_id as it resolves, there is no");
    console.log("side-effect-free preview mode for this step (matches backfill-trade-chains.ts's own");
    console.log("apply gate in spirit, but resolution itself is idempotent/non-destructive — re-running");
    console.log("is safe). Rerun with --apply to actually run it.");
    return;
  }

  let totalResolved = 0;
  let totalUnresolved = 0;
  const unresolved: Array<{ symbol: string; optionCount: number; firstOpen: string }> = [];

  for (const sym of symbols) {
    try {
      const result = await buildAndPersistCampaigns(userId, sym);
      totalResolved += result.resolved;
      totalUnresolved += result.unresolved;
      unresolved.push(...result.unresolvedChains);
      if (result.resolved > 0 || result.unresolved > 0) {
        console.log(`${sym}: ${result.resolved} resolved, ${result.unresolved} unresolved`);
      }
    } catch (e) {
      console.warn(`${sym}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n=== TOTAL ===`);
  console.log(`chains resolved into campaigns: ${totalResolved}`);
  console.log(`chains unresolved (no earnings event found): ${totalUnresolved}`);
  if (unresolved.length > 0) {
    console.log(`\nunresolved chains:`);
    for (const u of unresolved) {
      console.log(`  ${u.symbol}: ${u.optionCount} option leg(s), first open ${u.firstOpen}`);
    }
  }

  const campRes = await sb.from("campaigns").select("id").eq("user_id", userId);
  console.log(`\ndistinct campaigns after backfill: ${(campRes.data ?? []).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
