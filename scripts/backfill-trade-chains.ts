// Retroactive trade-chain classification over the whole account.
//   npx tsx scripts/backfill-trade-chains.ts            → dry run (prints)
//   npx tsx scripts/backfill-trade-chains.ts --apply    → persists
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
  const { classifyUserChains, persistChains } = await import("../lib/trade-chains");
  const userId = "abfe5a91-6b34-4227-a60d-71c9249b372d";

  const chains = await classifyUserChains(userId);
  // swing/speculative are never auto-detected (lib/trade-chains.ts's
  // TradeType comment) — they only exist after a manual
  // reclassification, which this auto-detection pass never produces.
  // Kept in the tally purely for type-completeness against the
  // 5-value TradeType union.
  const counts = { clean: 0, rolled: 0, recovery_play: 0, swing: 0, speculative: 0 };
  for (const c of chains) counts[c.tradeType] += 1;
  console.log(
    `${chains.length} chains: ${counts.clean} clean, ${counts.rolled} rolled, ${counts.recovery_play} recovery plays\n`,
  );

  // Print every non-clean chain + ZS/GWRE in full.
  for (const c of chains) {
    const sym = c.members[0].symbol;
    const interesting =
      c.tradeType !== "clean" || sym === "ZS" || sym === "GWRE";
    if (!interesting) continue;
    const span = `${c.members[0].opened_date} → ${c.members
      .map((m) => m.closed_date ?? "open")
      .sort()
      .pop()}`;
    console.log(
      `[${c.tradeType.toUpperCase()}] ${sym} (${c.members[0].broker}) — ${c.optionCount} option leg(s), ${c.members.length} members, ${span}`,
    );
    console.log(
      `  chainPnl $${c.chainPnl} | peakCapital ${c.peakCapital !== null ? "$" + c.peakCapital : "—"} | ${c.reasons.join("; ")}`,
    );
    for (const m of c.members) {
      console.log(
        `    ${m.position_type === "stock_long" ? "STOCK" : `$${m.strike}P ${m.expiry}`} ${m.opened_date}→${m.closed_date ?? "open"} pnl $${m.realized_pnl} [${m.status}]`,
      );
    }
  }

  if (apply) {
    const n = await persistChains(chains, "auto", { skipConfirmed: true });
    console.log(`\npersisted: ${n} positions updated`);
  } else {
    console.log("\nDRY RUN — rerun with --apply to persist");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
