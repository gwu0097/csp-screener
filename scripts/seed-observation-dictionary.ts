// One-time seed for the observation dictionary (Phase A of the
// CANDIDATE_OBSERVATIONS work — see lib/observation-dictionary.ts and
// migrations/2026-08-06-add-observation-dictionary.sql). Inserts the 32
// terms drawn from analyses already on file before the v4 template
// existed, so the dictionary starts populated instead of empty.
//
// For each term: if it appears verbatim in a stored
// research_analyses.candidate_flags array, usages (and their
// created_at) are derived from those real rows. Otherwise falls back to
// the (symbol, earnings_date) citations below — for terms that were
// discussed in an analysis's prose under different phrasing than what
// ended up in that response's flat CANDIDATE_FLAGS line, or that
// reference a state no current row reflects (e.g. AAOI pre-backfill).
// Fallback usages get a synthetic created_at (noon UTC on the earnings
// date) since no real timestamp exists for them.
//
// Idempotent — upserts on (term) / (term, symbol, earnings_date), safe
// to rerun. Usage: npx tsx scripts/seed-observation-dictionary.ts [--apply]
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

type Kind = "setup_observation" | "app_defect";
type Citation = { symbol: string; earningsDate: string };
type SeedTerm = { term: string; kind: Kind; definition: string; fallbackCitations: Citation[] };

const SEED_TERMS: SeedTerm[] = [
  // --- setup_observation ---
  {
    term: "em_compressed_vs_history",
    kind: "setup_observation",
    definition:
      "Today's implied move is materially lower than this ticker's own recent EM history, so the 2x EM strike sits closer in absolute terms than the same rule would have produced in prior quarters. Used where the compression looks like mispricing rather than a justified regime change.",
    fallbackCitations: [
      { symbol: "APP", earningsDate: "2026-08-05" },
      { symbol: "RKT", earningsDate: "2026-08-06" },
      { symbol: "NET", earningsDate: "2026-08-06" },
    ],
  },
  {
    term: "whisper_above_consensus",
    kind: "setup_observation",
    definition:
      "Published consensus understates the bar the market is actually pricing, so a beat against consensus can still disappoint and reprice the stock downward.",
    fallbackCitations: [{ symbol: "NET", earningsDate: "2026-08-06" }],
  },
  {
    term: "chronic_ratio_above_one",
    kind: "setup_observation",
    definition:
      "The ticker's realized move exceeds its implied move in most quarters, not just occasionally — a persistent structural under-pricing rather than a single outlier. Tolerable only when the absolute move sizes are small.",
    fallbackCitations: [{ symbol: "TXRH", earningsDate: "2026-08-06" }],
  },
  {
    term: "low_em_produces_close_strike",
    kind: "setup_observation",
    definition:
      "A compressed EM makes the 2x EM rule produce a strike that is close in percentage terms with a high delta, unlike the same rule applied to a high-EM name. The rule's output is not comparable across EM regimes.",
    fallbackCitations: [
      { symbol: "TXRH", earningsDate: "2026-08-06" },
      { symbol: "ROKU", earningsDate: "2026-08-06" },
    ],
  },
  {
    term: "binary_single_catalyst",
    kind: "setup_observation",
    definition:
      "The setup's distribution is barbell-shaped rather than normal: a high probability of near-zero move and a low probability of a very large one, driven by one specific disclosure rather than by the financial results. EM-based reasoning models the wrong distribution shape.",
    fallbackCitations: [{ symbol: "TTWO", earningsDate: "2026-08-07" }],
  },
  {
    term: "mean_ratio_masks_direction",
    kind: "setup_observation",
    definition:
      "The mean move ratio looks benign or alarming for the wrong reason because it aggregates upside and downside blow-throughs together. Only the downside ratio matters to a put seller.",
    fallbackCitations: [{ symbol: "AAOI", earningsDate: "2026-08-06" }],
  },
  {
    term: "demonstrated_magnitude_capacity",
    kind: "setup_observation",
    definition:
      "The ticker has demonstrated it can move several times its implied move, even if every observed instance has been to the upside. The magnitude capacity is proven; the direction asymmetry is assumed.",
    fallbackCitations: [{ symbol: "AAOI", earningsDate: "2026-08-06" }],
  },
  {
    term: "active_derating_trend",
    kind: "setup_observation",
    definition:
      "A stock already well off its highs on an unresolved narrative is not \"de-risked\" — the ongoing decline is evidence the question is live, not settled.",
    fallbackCitations: [{ symbol: "APP", earningsDate: "2026-08-05" }],
  },
  {
    term: "absent_tail_hedging",
    kind: "setup_observation",
    definition:
      "Very little put volume sits in the tail band on a ticker with demonstrated downside capacity, indicating one-sided positioning rather than genuine calm.",
    fallbackCitations: [{ symbol: "APP", earningsDate: "2026-08-05" }],
  },
  {
    term: "runup_into_print_from_lows",
    kind: "setup_observation",
    definition:
      "The stock has bounced sharply off recent lows into the print, distinct from a steady run-up. Broken uptrend plus reflexive bounce plus event catalyst is the setup where a disappointment gives back the bounce and resumes the downtrend.",
    fallbackCitations: [{ symbol: "AAOI", earningsDate: "2026-08-06" }],
  },
  {
    term: "prior_loss_on_ticker",
    kind: "setup_observation",
    definition:
      "A documented prior loss exists on this exact ticker at this event type. The checklist does not ask about position history, but it is directly relevant.",
    fallbackCitations: [{ symbol: "NET", earningsDate: "2026-08-06" }],
  },
  {
    term: "no_safe_strike_in_chain",
    kind: "setup_observation",
    definition:
      "No strike with a real bid clears the ticker's worst historical down move. This is not a strike-selection problem that can be solved by moving further out.",
    fallbackCitations: [{ symbol: "NET", earningsDate: "2026-08-06" }],
  },
  {
    term: "annual_guidance_print",
    kind: "setup_observation",
    definition:
      "The report covers a fiscal year end and will carry initial full-year guidance for the next year — structurally higher variance than a mid-year quarter, because a year of assumptions is priced in one session.",
    fallbackCitations: [{ symbol: "TEAM", earningsDate: "2026-08-06" }],
  },
  {
    term: "em_understates_realized_range",
    kind: "setup_observation",
    definition:
      "The ticker's 52-week range is far wider than its earnings moves, meaning large repricing happens between prints rather than on them. The EM describes the event, not the stock's capacity to move.",
    fallbackCitations: [{ symbol: "TEAM", earningsDate: "2026-08-06" }],
  },
  {
    term: "exact_prior_year_analog",
    kind: "setup_observation",
    definition:
      "The same fiscal quarter one year prior produced a large move under materially the same conditions (positioning, consensus-vs-guide, narrative).",
    fallbackCitations: [{ symbol: "ABNB", earningsDate: "2026-08-06" }],
  },
  {
    term: "guidance_reaction_precedent",
    kind: "setup_observation",
    definition:
      "The ticker has a documented history of beating on results and still falling on guidance or margin commentary.",
    fallbackCitations: [{ symbol: "ABNB", earningsDate: "2026-08-06" }],
  },
  {
    term: "pending_acquisition",
    kind: "setup_observation",
    definition:
      "The ticker is subject to a signed acquisition agreement, so its price is anchored to a deal package rather than to fundamentals. Earnings cannot reprice it materially; the live variables are deal completion and, for stock-component deals, the acquirer's share price.",
    fallbackCitations: [{ symbol: "ROKU", earningsDate: "2026-08-06" }],
  },
  {
    term: "historical_regime_break",
    kind: "setup_observation",
    definition:
      "The stored earnings history predates a structural change (acquisition, spin-off, business model shift) and describes a different security. Ratio and cushion math computed on it is not applicable.",
    fallbackCitations: [{ symbol: "ROKU", earningsDate: "2026-08-06" }],
  },
  {
    term: "no_earnings_call",
    kind: "setup_observation",
    definition:
      "The company will not host a call or provide guidance, removing the channel through which most large earnings moves are produced.",
    fallbackCitations: [{ symbol: "ROKU", earningsDate: "2026-08-06" }],
  },
  {
    term: "acquirer_earnings_same_day",
    kind: "setup_observation",
    definition:
      "For a stock-component acquisition, the acquirer's own earnings date is a distinct risk vector transmitted into the target's price. The checklist does not ask about it.",
    fallbackCitations: [{ symbol: "ROKU", earningsDate: "2026-08-06" }],
  },
  {
    term: "expiry_same_day_as_print",
    kind: "setup_observation",
    definition: "The option expires the same session the earnings reaction lands, leaving no overnight window for a recovery bounce.",
    fallbackCitations: [{ symbol: "TTWO", earningsDate: "2026-08-07" }],
  },
  {
    term: "unusual_call_scheduling",
    kind: "setup_observation",
    definition:
      "The company has broken its own scheduling pattern (day of week, pre- vs post-market), which historically precedes a non-routine announcement.",
    fallbackCitations: [{ symbol: "TTWO", earningsDate: "2026-08-07" }],
  },
  {
    term: "strike_near_52w_low",
    kind: "setup_observation",
    definition:
      "The reference strike sits close to the 52-week low, meaning the stock has traded at that level within the year — the strike is not in unreached territory even if it is far from a one-day move.",
    fallbackCitations: [{ symbol: "TTWO", earningsDate: "2026-08-07" }],
  },
  {
    term: "dilution_risk_at_print",
    kind: "setup_observation",
    definition:
      "The company has a large capex program and limited runway, making a capital raise plausible; if announced alongside results it is a down-catalyst independent of the quarter.",
    fallbackCitations: [{ symbol: "AAOI", earningsDate: "2026-08-06" }],
  },

  // --- app_defect ---
  // pop_override_on_failing_crush removed — see
  // migrations/2026-08-23-remove-pop-override-crush-observation.sql.
  // Crush left the finalGrade cascade entirely in the Tradable Grade
  // restructure (lib/tradable-grade.ts), so there is no longer a crush
  // term for POP to override.
  {
    term: "unfillable_reference_strike",
    kind: "app_defect",
    definition:
      "The recommended strike has no real market (zero or near-zero OI/volume, very wide spread), so the mid driving EV is interpolation rather than a fillable price.",
    fallbackCitations: [
      { symbol: "TTWO", earningsDate: "2026-08-07" },
      { symbol: "AAOI", earningsDate: "2026-08-06" },
    ],
  },
  {
    term: "dead_chain_no_market",
    kind: "app_defect",
    definition: "Most or all strikes in the window show zero bids and zero volume; the chain as a whole is untradeable, not merely wide.",
    fallbackCitations: [
      { symbol: "TEAM", earningsDate: "2026-08-06" },
      { symbol: "TXRH", earningsDate: "2026-08-06" },
    ],
  },
  {
    term: "illiquid_at_reference_strike",
    kind: "app_defect",
    definition:
      "The reference strike is materially less liquid than an adjacent strike that pays the same or more, so the recommendation should move.",
    fallbackCitations: [{ symbol: "AAOI", earningsDate: "2026-08-06" }],
  },
  {
    term: "cushion_math_invalid_on_regime_change",
    kind: "app_defect",
    definition:
      "STRIKE VS WORST DOWN MOVE is computed against pre-regime-change history and produces a number that is arithmetically correct but substantively meaningless.",
    fallbackCitations: [{ symbol: "ROKU", earningsDate: "2026-08-06" }],
  },
  {
    term: "verified_modifier_not_applied",
    kind: "app_defect",
    definition: "verifiedModifier computes a non-zero delta but reports applied=false, so a detected penalty or credit does not reach the grade.",
    fallbackCitations: [{ symbol: "TXRH", earningsDate: "2026-08-06" }],
  },
  {
    term: "blind_history",
    kind: "app_defect",
    definition:
      "n=0 paired quarters, so historicalMove is excluded and the grade has no information about how the ticker moves on earnings — yet still produces a letter.",
    fallbackCitations: [
      { symbol: "AAOI", earningsDate: "2026-08-06" },
      { symbol: "ELF", earningsDate: "2026-08-05" },
    ],
  },
  {
    term: "thin_chain_workable_limit",
    kind: "app_defect",
    definition:
      "The chain is thin but a fill materially better than the bid is achievable by working a limit; the displayed bid understates realistic execution.",
    fallbackCitations: [{ symbol: "TXRH", earningsDate: "2026-08-06" }],
  },
];

type UsageRow = { symbol: string; earningsDate: string; createdAt: string };

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();
  const APPLY = process.argv.includes("--apply");

  const res = await sb
    .from("research_analyses")
    .select("symbol,earnings_date,candidate_flags,created_at");
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data ?? []) as {
    symbol: string;
    earnings_date: string;
    candidate_flags: string[];
    created_at: string;
  }[];

  const actualUsagesByTerm = new Map<string, UsageRow[]>();
  for (const row of rows) {
    for (const term of row.candidate_flags ?? []) {
      const list = actualUsagesByTerm.get(term) ?? [];
      list.push({ symbol: row.symbol, earningsDate: row.earnings_date, createdAt: row.created_at });
      actualUsagesByTerm.set(term, list);
    }
  }

  let termsSeen = 0;
  let derivedTerms = 0;
  let fallbackTerms = 0;
  let usagesWritten = 0;

  for (const seed of SEED_TERMS) {
    termsSeen += 1;
    const actual = actualUsagesByTerm.get(seed.term) ?? [];
    const usages: UsageRow[] =
      actual.length > 0
        ? actual
        : seed.fallbackCitations.map((c) => ({
            symbol: c.symbol,
            earningsDate: c.earningsDate,
            createdAt: `${c.earningsDate}T12:00:00.000Z`,
          }));
    if (actual.length > 0) derivedTerms += 1;
    else fallbackTerms += 1;

    const times = usages.map((u) => new Date(u.createdAt).getTime());
    const firstUsedAt = new Date(Math.min(...times)).toISOString();
    const lastUsedAt = new Date(Math.max(...times)).toISOString();
    const source = actual.length > 0 ? "derived" : "fallback";

    console.log(`[${source}] ${seed.term} (${seed.kind}) — ${usages.length} usage(s)`);
    for (const u of usages) console.log(`    ${u.symbol} ${u.earningsDate}`);

    if (APPLY) {
      const dictRes = await sb.from("observation_dictionary").upsert(
        {
          term: seed.term,
          definition: seed.definition,
          kind: seed.kind,
          use_count: usages.length,
          first_used_at: firstUsedAt,
          last_used_at: lastUsedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "term" },
      );
      if (dictRes.error) {
        throw new Error(`dictionary upsert failed for ${seed.term}: ${dictRes.error.message}`);
      }

      for (const u of usages) {
        const usageRes = await sb.from("observation_usages").upsert(
          { term: seed.term, symbol: u.symbol, earnings_date: u.earningsDate, created_at: u.createdAt },
          { onConflict: "term,symbol,earnings_date" },
        );
        if (usageRes.error) {
          throw new Error(
            `usage upsert failed for ${seed.term}/${u.symbol}/${u.earningsDate}: ${usageRes.error.message}`,
          );
        }
        usagesWritten += 1;
      }
    }
  }

  console.log(
    `\n${termsSeen} term(s) — ${derivedTerms} derived from stored candidate_flags, ${fallbackTerms} from fallback citations.`,
  );
  console.log(
    APPLY
      ? `Applied. ${usagesWritten} usage row(s) upserted.`
      : "Dry run — pass --apply to write to the database.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
