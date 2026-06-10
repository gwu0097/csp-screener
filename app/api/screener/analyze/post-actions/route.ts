import { NextResponse } from "next/server";
import { writeOpenPositionSnapshots } from "@/lib/snapshots";
import { runEncyclopediaMaintenance } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Post-analysis maintenance — position snapshots + encyclopedia
// upkeep. Split out of pass3b so the grade response isn't blocked
// behind a maintenance sweep that scales with the encyclopedia /
// positions tables rather than the analyzed batch (sequential Yahoo
// reingests + 1s-gapped Perplexity backfills could push a 1-symbol
// Run Analysis past 2 minutes). The client fires this once, without
// awaiting, after the final grade batch lands; getting its own route
// also gives the work a fresh 60s budget instead of whatever pass3b
// had left.
export const maxDuration = 60;

export async function POST() {
  const t0 = Date.now();

  const [snapshotResult, encyclopediaUpdates] = await Promise.all([
    writeOpenPositionSnapshots(),
    (async () => {
      try {
        const report = await runEncyclopediaMaintenance();
        return (
          report.t0Captured.length +
          report.t1Captured.length +
          report.expiryBackfilled.length +
          report.perplexityBackfilled.length
        );
      } catch (e) {
        console.warn(
          `[analyze/post-actions:encyclopedia] failed: ${e instanceof Error ? e.message : e}`,
        );
        return 0;
      }
    })(),
  ]);

  const elapsed = Date.now() - t0;
  if (snapshotResult.errors.length > 0) {
    console.warn(
      `[analyze/post-actions] snapshot errors: ${snapshotResult.errors.join("; ")}`,
    );
  }
  console.log(
    `[analyze/post-actions] snapshots=${snapshotResult.written} encyclopedia=${encyclopediaUpdates} · ${elapsed}ms`,
  );

  return NextResponse.json({
    snapshotsWritten: snapshotResult.written,
    encyclopediaUpdates,
    elapsedMs: elapsed,
  });
}
