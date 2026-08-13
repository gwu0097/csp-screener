// One-time backfill for the 2026-08-13 CANDIDATE_OBSERVATIONS parser bug
// (fixed in lib/research-analysis-parser.ts: extractCandidateObservationsBlock
// required indentation that real pastes stopped using on 2026-08-11).
// Re-parses raw_paste with the now-fixed parser for every affected
// research_analyses row and replays the exact save-path logic
// (classifyObservations + upsertDictionaryTerms + syncObservationUsages,
// all imported — not reimplemented) in chronological order, so a term
// defined earlier in this batch resolves correctly for a later reuse in
// the same batch.
//
// Two terms are excluded from every row that bare-reuses them
// (verified_modifier_not_applied, pop_override_on_failing_crush): no
// stored raw_paste anywhere in the table contains a `term: definition`
// line for either, so there is no source to recover a definition from —
// writing a usage row for them would fabricate provenance the live
// validation gate would have rejected (new_missing_definition blocks
// save). Left for a human decision; see backfill report.
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

const ORPHANED_TERMS = new Set(["verified_modifier_not_applied", "pop_override_on_failing_crush"]);

// Definitions come verbatim from each paste's own text (see report); kind
// is a judgment call this backfill has to make since the response format
// has no field for it (normally chosen at save time via the paste-back
// UI). All read as describing a market/setup condition except the three
// that describe the app's own scoring/selection logic malfunctioning.
const NEW_TERM_KINDS: Record<string, "setup_observation" | "app_defect"> = {
  beat_but_fell_precedent: "setup_observation",
  second_print_as_public_company: "setup_observation",
  peer_print_precedes_own_print: "setup_observation",
  thin_downside_sample: "setup_observation",
  event_iv_no_premium_to_realized: "setup_observation",
  selected_strike_inside_worst_down_move: "app_defect",
  personal_history_boost_from_single_event: "app_defect",
  grade_cites_unselected_strike: "app_defect",
  quarter_preannounced_guidance_only: "setup_observation",
  working_capital_absorbs_growth: "setup_observation",
  audit_signoff_risk_at_fiscal_year_end: "setup_observation",
  iv_edge_scoring_non_monotonic: "app_defect",
  mechanical_beat_not_catalyst: "setup_observation",
  crush_threshold_equality_fails: "app_defect",
};

// Chronological order matters: a term defined earlier in this list must
// resolve as existing_reused for a bare reuse later in the list (e.g.
// iv_edge_scoring_non_monotonic, defined in SMCI, reused bare in CAVA).
const TARGETS: Array<{ symbol: string; earningsDate: string }> = [
  { symbol: "NBIS", earningsDate: "2026-08-12" },
  { symbol: "CRWV", earningsDate: "2026-08-11" },
  { symbol: "SMCI", earningsDate: "2026-08-11" },
  { symbol: "CAVA", earningsDate: "2026-08-11" },
  { symbol: "TPR", earningsDate: "2026-08-13" },
  { symbol: "CBRS", earningsDate: "2026-08-12" },
  { symbol: "CSCO", earningsDate: "2026-08-12" },
  { symbol: "AMAT", earningsDate: "2026-08-13" },
];

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { parseResearchAnalysisPaste } = await import("../lib/research-analysis-parser");
  const { buildDictionaryMap, classifyObservations } = await import("../lib/observation-dictionary");
  const { upsertDictionaryTerms, syncObservationUsages } = await import("../lib/observation-sync");
  const sb = createServerClient();

  const skippedOrphans: Array<{ symbol: string; term: string }> = [];

  for (const { symbol, earningsDate } of TARGETS) {
    const rowRes = await sb
      .from("research_analyses")
      .select("symbol, earnings_date, raw_paste, candidate_flags, created_at")
      .eq("symbol", symbol)
      .eq("earnings_date", earningsDate)
      .single();
    if (rowRes.error || !rowRes.data) {
      console.error(`[${symbol}] fetch failed: ${rowRes.error?.message ?? "not found"}`);
      process.exitCode = 1;
      continue;
    }
    const row = rowRes.data as { raw_paste: string; candidate_flags: string[] | null; created_at: string };

    const parsed = parseResearchAnalysisPaste(row.raw_paste);
    if (!parsed.observationsBlockFound) {
      console.error(`[${symbol}] block not found after fix — skipping, needs manual look`);
      process.exitCode = 1;
      continue;
    }

    const usable = parsed.candidateObservations.filter((o) => !ORPHANED_TERMS.has(o.term));
    for (const o of parsed.candidateObservations) {
      if (ORPHANED_TERMS.has(o.term)) skippedOrphans.push({ symbol, term: o.term });
    }

    const dictRes = await sb.from("observation_dictionary").select("*");
    if (dictRes.error) {
      console.error(`[${symbol}] dictionary fetch failed: ${dictRes.error.message}`);
      process.exitCode = 1;
      continue;
    }
    const dictMap = buildDictionaryMap(dictRes.data as Parameters<typeof buildDictionaryMap>[0]);

    const classifications = classifyObservations(usable, dictMap);
    const unresolvable = classifications.filter((c) => c.status === "new_missing_definition");
    if (unresolvable.length > 0) {
      console.error(
        `[${symbol}] unexpected new_missing_definition after orphan filter: ${unresolvable.map((c) => c.term).join(", ")}`,
      );
      process.exitCode = 1;
      continue;
    }

    const newTermKinds: Record<string, "setup_observation" | "app_defect"> = {};
    for (const c of classifications) {
      if (c.status === "new_with_definition") {
        const kind = NEW_TERM_KINDS[c.term];
        if (!kind) {
          console.error(`[${symbol}] no kind assigned for new term ${c.term} — skipping row`);
          process.exitCode = 1;
          continue;
        }
        newTermKinds[c.term] = kind;
      }
    }

    const dictWrite = await upsertDictionaryTerms(sb, classifications, {
      newTermKinds,
      useNewDefinitionFor: [],
    });
    if (!dictWrite.ok) {
      console.error(`[${symbol}] dictionary write failed: ${dictWrite.error}`);
      process.exitCode = 1;
      continue;
    }

    const finalTerms = Array.from(new Set(usable.map((o) => o.term)));
    const usagesWrite = await syncObservationUsages(sb, symbol, earningsDate, finalTerms, row.created_at);
    if (!usagesWrite.ok) {
      console.error(`[${symbol}] usages sync failed: ${usagesWrite.error}`);
      process.exitCode = 1;
      continue;
    }

    const flagsUpdate = await sb
      .from("research_analyses")
      .update({ candidate_flags: finalTerms })
      .eq("symbol", symbol)
      .eq("earnings_date", earningsDate);
    if (flagsUpdate.error) {
      console.error(`[${symbol}] candidate_flags update failed: ${flagsUpdate.error.message}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`[${symbol}] backfilled ${finalTerms.length} terms: ${finalTerms.join(", ") || "(none)"}`);
  }

  if (skippedOrphans.length > 0) {
    console.log("\nSkipped orphaned terms (no definition found in any stored raw_paste):");
    for (const s of skippedOrphans) console.log(`  ${s.symbol}: ${s.term}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
