import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  // tracked_tickers by screened_date
  const tt = await sb
    .from("tracked_tickers")
    .select("id,screened_date");
  if (tt.error) {
    console.log("tracked_tickers error:", tt.error.message);
  } else {
    const rows = (tt.data ?? []) as Array<{ id: string; screened_date: string | null }>;
    const byDate = new Map<string, number>();
    for (const r of rows) {
      const d = r.screened_date ?? "(null)";
      byDate.set(d, (byDate.get(d) ?? 0) + 1);
    }
    const entries = Array.from(byDate.entries()).sort((a, b) =>
      b[0].localeCompare(a[0]),
    );
    console.log(`tracked_tickers total=${rows.length}`);
    console.log("by screened_date (top 5, desc):");
    for (const [d, n] of entries.slice(0, 5)) {
      console.log(`  ${d}  count=${n}`);
    }
  }

  console.log();

  // position_snapshots by date(snapshot_time)
  const ps = await sb
    .from("position_snapshots")
    .select("id,snapshot_time");
  if (ps.error) {
    console.log("position_snapshots error:", ps.error.message);
  } else {
    const rows = (ps.data ?? []) as Array<{ id: string; snapshot_time: string | null }>;
    const byDate = new Map<string, number>();
    for (const r of rows) {
      const d = r.snapshot_time ? r.snapshot_time.slice(0, 10) : "(null)";
      byDate.set(d, (byDate.get(d) ?? 0) + 1);
    }
    const entries = Array.from(byDate.entries()).sort((a, b) =>
      b[0].localeCompare(a[0]),
    );
    console.log(`position_snapshots total=${rows.length}`);
    console.log("by date(snapshot_time) (top 5, desc):");
    for (const [d, n] of entries.slice(0, 5)) {
      console.log(`  ${d}  count=${n}`);
    }
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
