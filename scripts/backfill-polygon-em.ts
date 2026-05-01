// Run while Polygon subscription is active.
// Idempotent — only fetches rows with implied_move_pct = NULL.
// Usage: npx tsx scripts/backfill-polygon-em.ts
//
// Drains every earnings_history row that has an actual move but no
// implied move, using Polygon historical aggregates. Talks to
// Supabase directly via env vars from .env.local — no HTTP routes,
// no UI involvement. Per-event runtime is ~3-5s against the paid
// Polygon tier (noSleep=true skips the 13s inter-aggs spacers
// needed for free-tier rate limits).
//
// First full run on 2026-04-30 took ~2h50m for 841 candidates and
// populated 400 rows. The 441 skipped rows are mostly "no contracts
// in band" — Polygon's contract reference table doesn't have entries
// for the targeted weekly Friday — and aren't recoverable through
// this method on the current Polygon endpoints.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// tsx doesn't auto-load .env files. Parse .env.local before any
// imports that pull env vars (Supabase / Polygon clients both do).
function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn(
      "[backfill] could not load .env.local:",
      e instanceof Error ? e.message : e,
    );
  }
}
loadEnvLocal();

// Type-only imports (erased at runtime) so the supabase module isn't
// loaded — and doesn't snapshot process.env — until after main()
// runs loadEnvLocal() and dynamically imports the real symbols.
import type { EarningsRow } from "../lib/polygon-em";

async function main() {
  // Dynamic imports so the supabase + polygon-em modules read
  // process.env AFTER loadEnvLocal() above has populated it.
  const { createServerClient } = await import("../lib/supabase");
  const { POLYGON_DEPTH_CUTOFF, processPolygonEvent } = await import(
    "../lib/polygon-em"
  );

  const sb = createServerClient();
  const t0 = Date.now();

  console.log("[backfill] fetching candidate rows from earnings_history…");
  const allRes = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
    )
    .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
    .order("earnings_date", { ascending: false });
  if (allRes.error) {
    console.error("[backfill] DB read failed:", allRes.error.message);
    process.exit(1);
  }
  const all = (allRes.data ?? []) as EarningsRow[];
  const pending = all.filter(
    (r) => r.actual_move_pct !== null && r.implied_move_pct === null,
  );
  const total = pending.length;

  console.log(
    `[backfill] ${all.length} rows in window (>= ${POLYGON_DEPTH_CUTOFF}); ${total} need implied_move_pct populated\n`,
  );
  if (total === 0) {
    console.log("[backfill] nothing to do.");
    return;
  }

  let populated = 0;
  let skipped = 0;
  let errored = 0;
  const skipReasons: Record<string, number> = {};
  const errSamples: string[] = [];

  for (let i = 0; i < pending.length; i += 1) {
    const row = pending[i];
    const idx = `[${String(i + 1).padStart(String(total).length)}/${total}]`;
    const label = `${row.symbol.padEnd(6)} ${row.earnings_date}`;

    let outcome;
    try {
      outcome = await processPolygonEvent(row, { noSleep: true });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errored += 1;
      if (errSamples.length < 5) errSamples.push(`${row.symbol} ${row.earnings_date}: ${reason}`);
      console.log(`${idx} ${label} → ERROR: ${reason}`);
      continue;
    }

    if (outcome.kind === "populated") {
      const upd = await sb
        .from("earnings_history")
        .update({
          implied_move_pct: outcome.emPct,
          implied_move_source: "polygon",
        })
        .eq("symbol", row.symbol)
        .eq("earnings_date", row.earnings_date);
      if (upd.error) {
        errored += 1;
        if (errSamples.length < 5) errSamples.push(`${row.symbol} ${row.earnings_date}: DB ${upd.error.message}`);
        console.log(`${idx} ${label} → DB write failed: ${upd.error.message}`);
      } else {
        populated += 1;
        const pct = (outcome.emPct * 100).toFixed(2);
        console.log(`${idx} ${label} → EM: ${pct}% @ $${outcome.strike} ✓`);
      }
    } else if (outcome.kind === "skip_too_old") {
      skipped += 1;
      skipReasons["outside Polygon 24-month window"] = (skipReasons["outside Polygon 24-month window"] ?? 0) + 1;
      console.log(`${idx} ${label} → skipped (outside Polygon 24-month window)`);
    } else if (outcome.kind === "skip_no_contracts") {
      skipped += 1;
      skipReasons["no contracts"] = (skipReasons["no contracts"] ?? 0) + 1;
      console.log(`${idx} ${label} → skipped (${outcome.reason})`);
    } else if (outcome.kind === "skip_no_data") {
      skipped += 1;
      skipReasons["no leg data"] = (skipReasons["no leg data"] ?? 0) + 1;
      console.log(`${idx} ${label} → skipped (${outcome.reason})`);
    } else {
      errored += 1;
      if (errSamples.length < 5) errSamples.push(`${row.symbol} ${row.earnings_date}: ${outcome.reason}`);
      console.log(`${idx} ${label} → error: ${outcome.reason}`);
    }
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`=== Summary (${dur}s) ===`);
  console.log(`Populated: ${populated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errors:    ${errored}`);
  console.log(`Total:     ${pending.length}`);
  if (Object.keys(skipReasons).length > 0) {
    console.log("\nSkip-reason breakdown:");
    for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }
  if (errSamples.length > 0) {
    console.log("\nFirst error samples:");
    for (const s of errSamples) console.log(`  ${s}`);
  }
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
