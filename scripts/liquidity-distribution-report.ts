// Distribution of spread%/OI/volume at RECOMMENDED strikes across
// historical screener runs — the evidence base for lib/liquidity.ts's
// threshold constants. Re-run periodically (chain liquidity shifts
// with market conditions) and adjust those constants directly if the
// shape drifts meaningfully.
//   npx tsx scripts/liquidity-distribution-report.ts
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

function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

type Sample = {
  symbol: string;
  strike: number;
  spreadPct: number;
  oi: number;
  volume: number;
  yieldPct: number;
  screenedAt: string;
};

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();

  const res = await sb.from("screener_results").select("screened_at,candidates,graded").eq("graded", true);
  type Row = { screened_at: string; candidates: unknown[] };
  const rows = (res.data ?? []) as Row[];
  console.log(`${rows.length} graded runs`);

  const samples: Sample[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const c of row.candidates as Array<Record<string, unknown>>) {
      const symbol = c.symbol as string | undefined;
      const sf = c.stageFour as Record<string, unknown> | undefined;
      if (!symbol || !sf) continue;
      const suggestedStrike = sf.suggestedStrike as number | null;
      const bidAskSpreadPct = sf.bidAskSpreadPct as number | null;
      const premiumYieldPct = sf.premiumYieldPct as number | null;
      const bid = sf.bid as number | null;
      if (suggestedStrike === null || bidAskSpreadPct === null) continue;
      // Exclude noBid (bid<=0) rows — already a hard F via the untouched
      // noBid gate, and bid=0 forces spreadPctOfMid to exactly 200% by
      // construction ((ask-0)/(ask/2)=2), which would skew this
      // distribution toward a population the graduated logic never
      // actually touches.
      if (bid === null || bid <= 0) continue;
      const availableStrikes = (sf.availableStrikes as Array<Record<string, unknown>> | undefined) ?? [];
      const match = availableStrikes.find((s) => Math.abs((s.strike as number) - suggestedStrike) < 0.01);
      if (!match) continue;
      const oi = Number(match.oi ?? 0);
      const volume = Number(match.volume ?? 0);
      // Same symbol+strike legitimately repeats across runs (the chain
      // barely moves day to day) — keep every run's read, that's the
      // real distribution of what got recommended over time, not a
      // symbol census. Dedup only within one run.
      const key = `${symbol}|${suggestedStrike}|${row.screened_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        symbol,
        strike: suggestedStrike,
        spreadPct: bidAskSpreadPct,
        oi,
        volume,
        yieldPct: premiumYieldPct ?? 0,
        screenedAt: row.screened_at,
      });
    }
  }
  console.log(`${samples.length} recommended-strike samples across ${rows.length} runs\n`);

  function report(label: string, arr: number[]) {
    console.log(`${label}: n=${arr.length}`);
    for (const p of [5, 10, 25, 50, 75, 90, 95, 99]) {
      console.log(`  p${p}: ${percentile(arr, p)}`);
    }
    console.log(`  min=${Math.min(...arr)} max=${Math.max(...arr)}`);
  }
  report("spread % of mid", samples.map((s) => s.spreadPct));
  console.log();
  report("open interest", samples.map((s) => s.oi));
  console.log();
  report("volume", samples.map((s) => s.volume));

  console.log("\n=== cross-tab ===");
  const cuts: Array<{ label: string; f: (s: Sample) => boolean }> = [
    { label: "OI < 10", f: (s) => s.oi < 10 },
    { label: "OI < 25", f: (s) => s.oi < 25 },
    { label: "OI < 50", f: (s) => s.oi < 50 },
    { label: "OI < 100", f: (s) => s.oi < 100 },
    { label: "volume < 5", f: (s) => s.volume < 5 },
    { label: "volume < 10", f: (s) => s.volume < 10 },
    { label: "volume < 25", f: (s) => s.volume < 25 },
    { label: "spread > 30%", f: (s) => s.spreadPct > 30 },
    { label: "spread > 50%", f: (s) => s.spreadPct > 50 },
    { label: "spread > 75%", f: (s) => s.spreadPct > 75 },
    { label: "spread > 100%", f: (s) => s.spreadPct > 100 },
    { label: "OI<25 AND volume<10", f: (s) => s.oi < 25 && s.volume < 10 },
    { label: "OI<10 AND volume<5 AND spread>50%", f: (s) => s.oi < 10 && s.volume < 5 && s.spreadPct > 50 },
  ];
  for (const cut of cuts) {
    const n = samples.filter(cut.f).length;
    console.log(`${cut.label}: ${n} (${((n / samples.length) * 100).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
