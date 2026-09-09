// Earnings Reports Stage A courier. Runs headless Claude Code (the
// user's Claude subscription, no API key — same mechanism proven by
// scripts/robinhood-courier.ts) to read an 8-K earnings-release exhibit
// whole (inline argv prompt, no tool calls) and produce structured
// signal cards (lib/earnings-analysis-cards.ts — the 2026-09-10
// Qualtrim-style redesign). Litigation/subsequent-events and the full
// quarter-over-quarter comparison are Stage B, once the 10-Q lands —
// not built yet.
//
// Run via a dedicated launchd agent, once daily, weekdays. Usage:
// npx tsx scripts/filing-analysis-stage-a-courier.ts [--dry]
//   --symbol=SYM         candidate-path override (still requires an
//                        earnings_history row, same guards as normal)
//   --force-symbol=SYM   bypasses candidate selection entirely, no
//                        earnings_history dependency — manual diagnostic
//   --backfill-symbol=SYM --quarters=N [--force-accession=ACC]
//                        walks the last N item-2.02 8-Ks for SYM
//                        (listRecentEarningsFilings, no freshness gate)
//                        and runs Stage A against each one not already
//                        captured with cards. No earnings_history_id
//                        dependency for discovery; still auto-links on
//                        an exact same-day match. --force-accession
//                        re-runs one specific already-captured accession
//                        even though it has cards (e.g. re-running a
//                        quarter after a validation-logic fix). No
//                        Discord post — watched, manual, one symbol at a
//                        time
//                        (2026-09-10 Deep Research backfill).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
// Type-only — erased at compile time, doesn't trigger module evaluation.
import type { CardsPayload, SectionKey } from "../lib/earnings-analysis-cards";
import type { RestClient } from "../lib/supabase";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}
loadEnvLocal();

const SCRIPT_STARTED_AT = Date.now();
function elapsedSeconds(): number {
  return (Date.now() - SCRIPT_STARTED_AT) / 1000;
}

const CLAUDE_BIN = "/Users/raitsai/.local/bin/claude";
// Card generation is far heavier than the old 2-section GUIDANCE/
// COMMENTARY prompt (~17-20s) -- measured 98.2s for NFLX (41K chars)
// and a timeout past 120s for SNOW (50K chars) during the 2026-09-10
// calibration run. 240s gives real headroom above the largest observed
// case rather than the old budget's now-stale comment.
const CLAUDE_TIMEOUT_MS = 240_000;
const RUN_BUDGET_MS = 600_000; // stop starting new candidates past this, matches T0/T1's per-run budget philosophy

// Whether a "stated" card whose metric_evidence doesn't verify against
// the source text gets DROPPED (true) or just logged for calibration
// (false) — see lib/earnings-analysis-cards.ts's verifyMetricEvidence.
// Set from the 2026-09-10 NFLX/SNOW calibration run; flip only after
// checking the false-positive rate on a real run, per that review.
const ENFORCE_STATED_VERIFICATION = true;

function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const SECTION_KEYS: SectionKey[] = ["ai_generated_insights", "what_changed_this_quarter", "red_flags", "strengths"];

function cardCounts(payload: CardsPayload): string {
  return SECTION_KEYS.map((k) => `${k}=${payload.sections[k].length}`).join(", ");
}

type CardRunOutcome =
  | { status: "captured"; analysisChars: number; countsSummary: string; droppedCount: number; droppedDetail: string[]; basisDefaultedCount: number; basisDefaultedDetail: string[] }
  | { status: "claude_failed"; detail: string }
  | { status: "invalid_output"; detail: string };

// Shared by both call sites (candidate-driven loop and --force-symbol)
// so the card-generation/validation/write logic exists exactly once.
async function runCardsPipeline(opts: {
  sb: RestClient;
  symbol: string;
  quarter: string;
  filingDate: string;
  pressText: string;
  notesPrefix: string;
  accessionNumber: string;
}): Promise<CardRunOutcome> {
  const { buildCardsPrompt, parseAndValidateCards, renderCardsAsText } = await import("../lib/earnings-analysis-cards");
  const prompt = buildCardsPrompt(opts.symbol, opts.quarter, opts.pressText);
  let claudeOut: string;
  const callStart = Date.now();
  try {
    claudeOut = execFileSync(CLAUDE_BIN, ["-p", prompt, "--allowedTools", ""], {
      encoding: "utf8",
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "claude_failed", detail: msg };
  }
  const callSeconds = (Date.now() - callStart) / 1000;
  console.log(`[filing-analysis-stage-a] ${opts.symbol}: claude -p returned in ${callSeconds.toFixed(1)}s, ${claudeOut.length} chars`);

  const result = parseAndValidateCards(claudeOut, opts.pressText, { enforceStatedVerification: ENFORCE_STATED_VERIFICATION });
  if (!result.ok) {
    return { status: "invalid_output", detail: result.reason };
  }
  if (result.dropped.length > 0) {
    console.warn(
      `[filing-analysis-stage-a] ${opts.symbol}: dropped ${result.dropped.length} card(s): ${result.dropped
        .map((d) => `[${d.section}] "${d.title}" — ${d.reason}`)
        .join(" | ")}`,
    );
  }
  if (result.basisDefaulted.length > 0) {
    console.warn(
      `[filing-analysis-stage-a] ${opts.symbol}: defaulted basis→inferred on ${result.basisDefaulted.length} card(s) (kept, not dropped): ${result.basisDefaulted
        .map((d) => `[${d.section}] "${d.title}" (raw=${d.rawBasis})`)
        .join(" | ")}`,
    );
  }
  console.log(`[filing-analysis-stage-a] ${opts.symbol}: cards — ${cardCounts(result.payload)}`);

  const analysisText = renderCardsAsText(result.payload);
  const notes = `${opts.notesPrefix}, pressText_chars=${opts.pressText.length}, claude_call_s=${callSeconds.toFixed(1)}, cards=[${cardCounts(result.payload)}], dropped=${result.dropped.length}, basis_defaulted=${result.basisDefaulted.length}`;
  const ins = await opts.sb.from("filing_analyses").upsert(
    {
      symbol: opts.symbol.toUpperCase(),
      filing_type: "8-K",
      period: opts.quarter,
      filing_date: opts.filingDate,
      accession_number: opts.accessionNumber,
      analysis_text: analysisText,
      cards: result.payload,
      notes,
      reviewed_at: new Date().toISOString(),
    },
    { onConflict: "symbol,filing_type,period" },
  );
  if (ins.error) {
    return { status: "invalid_output", detail: `write_failed: ${ins.error.message}` };
  }
  return {
    status: "captured",
    analysisChars: analysisText.length,
    countsSummary: cardCounts(result.payload),
    droppedCount: result.dropped.length,
    droppedDetail: result.dropped.map((d) => `[${d.section}] "${d.title}": ${d.reason}`),
    basisDefaultedCount: result.basisDefaulted.length,
    basisDefaultedDetail: result.basisDefaulted.map((d) => `[${d.section}] "${d.title}" (raw=${d.rawBasis})`),
  };
}

// pingWorthy distinguishes "log it, don't page" from "this needs a
// look" (2026-09-09, per the COO false-alert review). captured with
// zero dropped cards never pings; a dropped card is not the designed
// state (unlike "not yet filed"), so it pings even on an otherwise-
// successful run — that visibility into unsupported claims is the
// whole point of tracking drops (2026-09-10 review).
type RunResult =
  | { symbol: string; quarter: string; status: "captured"; analysisChars: number; countsSummary: string; droppedCount: number; droppedDetail: string[]; pingWorthy: boolean }
  | { symbol: string; quarter?: string; status: "pending"; detail: string; pingWorthy: false }
  | { symbol: string; quarter?: string; status: "no_release_found" | "claude_failed" | "invalid_output" | "write_failed"; detail: string; pingWorthy: true };

// --force-symbol=SYM: manual diagnostic run against a symbol regardless
// of earnings_history/candidate-window state — same shape as the
// existing manual "Fetch latest 8-K" UI button (no earnings_history
// dependency, no attempt logging), plus the claude -p card generation
// Stage A adds. Never writes an earnings_history_id link unless it's an
// exact, unique same-day match. No Discord post — this is a manual,
// watched run, not an unattended one.
async function runForceSymbol(symbol: string): Promise<void> {
  const { captureStageAReleaseForSymbol } = await import("../lib/filing-analysis-capture");
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();

  console.log(`[filing-analysis-stage-a] --force-symbol=${symbol}: capturing release (bypassing candidate selection)…`);
  const captured = await captureStageAReleaseForSymbol(symbol);
  if (!captured.ok) {
    const o = captured.outcome;
    console.log(`[filing-analysis-stage-a] RESULT: no_release_found (reason=${o.outcome === "no_release_found" ? o.reason : "?"}) — ${o.outcome === "no_release_found" ? o.detail : "unknown"}`);
    return;
  }
  console.log(`[filing-analysis-stage-a] release captured: ${symbol} ${captured.quarter}, filed ${captured.filingDate}, pressText=${captured.pressText.length} chars, exhibit_source=${captured.exhibitSource}`);

  const nearest = captured.nearestMatch;
  if (captured.linkedEarningsHistoryId) {
    console.log(`[filing-analysis-stage-a] earnings_history: LINKED id=${captured.linkedEarningsHistoryId} (exact same-day match, unique)`);
  } else if (nearest) {
    console.log(
      `[filing-analysis-stage-a] earnings_history: found id=${nearest.id} earnings_date=${nearest.earningsDate} (${nearest.dayDiff}d from filing date${nearest.uniqueAtDistance ? "" : ", tied with another row"}) — NOT linked`,
    );
  } else {
    console.log(`[filing-analysis-stage-a] earnings_history: no row within 5 days of ${captured.filingDate} — no matching row exists`);
  }

  const notesPrefix = `auto: filing-analysis-stage-a v1 [--force-symbol diagnostic], ${symbol} ${captured.quarter}, earnings_history_id=${captured.linkedEarningsHistoryId ?? (nearest ? `${nearest.id} (found, not linked)` : "none")}, exhibit_source=${captured.exhibitSource}`;
  const outcome = await runCardsPipeline({
    sb,
    symbol,
    quarter: captured.quarter,
    filingDate: captured.filingDate,
    pressText: captured.pressText,
    notesPrefix,
    accessionNumber: captured.accessionNumber,
  });
  if (outcome.status === "captured") {
    console.log(
      `[filing-analysis-stage-a] RESULT: captured — filing_analyses row written (${outcome.analysisChars} chars), ${outcome.countsSummary}, dropped=${outcome.droppedCount}`,
    );
    if (outcome.droppedDetail.length > 0) {
      console.log(`[filing-analysis-stage-a] DROPPED CARDS:\n  ${outcome.droppedDetail.join("\n  ")}`);
    }
  } else {
    console.log(`[filing-analysis-stage-a] RESULT: ${outcome.status} — ${outcome.detail}`);
  }
}

// --backfill-symbol=SYM --quarters=N: walk the last N item-2.02 8-Ks for
// a symbol regardless of the 5-day candidate window or earnings_history
// existence, and run Stage A on each one not already captured with
// cards. A filing already in earnings_releases (by accession_number)
// whose linked filing_analyses period already has non-null cards is
// skipped without spending a Perplexity call; a filing whose
// earnings_releases row exists but has no cards yet (e.g. captured
// pre-redesign) is re-run — accession_number is the identity, not the
// derived quarter label, since the quarter isn't known until after
// extraction. No CIK, or a CIK with zero item-2.02 8-Ks on file, is
// reported as excluded (foreign private issuer filing 6-K/20-F) rather
// than as a failure. No Discord post — watched, manual, one symbol at
// a time, matching --force-symbol's convention.
async function runBackfillSymbol(symbol: string, quarters: number, forceAccession?: string): Promise<void> {
  const { captureStageAReleaseForSymbol } = await import("../lib/filing-analysis-capture");
  const { listRecentEarningsFilings } = await import("../lib/earnings-release-capture");
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();
  const sym = symbol.toUpperCase();

  console.log(`[filing-analysis-stage-a] --backfill-symbol=${sym} quarters=${quarters}: listing recent item-2.02 8-Ks…`);
  const listed = await listRecentEarningsFilings(sym, quarters);
  if (!listed.ok) {
    console.log(`[filing-analysis-stage-a] RESULT: ${sym} EXCLUDED — no EDGAR CIK (likely a foreign private issuer filing 6-K/20-F, or delisted)`);
    return;
  }
  if (listed.filings.length === 0) {
    console.log(`[filing-analysis-stage-a] RESULT: ${sym} EXCLUDED — CIK found but zero item-2.02 8-Ks on file (foreign private issuer filing 6-K, or no earnings 8-Ks exist)`);
    return;
  }
  if (listed.filings.length < quarters) {
    console.log(`[filing-analysis-stage-a] NOTE: ${sym} has only ${listed.filings.length} item-2.02 8-K(s) on file, not ${quarters} — thin filing history, walking what exists`);
  }

  for (const f of listed.filings) {
    const existingRelease = await sb
      .from("earnings_releases")
      .select("quarter")
      .eq("symbol", sym)
      .eq("accession_number", f.accessionNumber);
    const existingQuarter = (existingRelease.data?.[0] as { quarter?: string } | undefined)?.quarter;
    if (existingQuarter) {
      const existingAnalysis = await sb
        .from("filing_analyses")
        .select("cards")
        .eq("symbol", sym)
        .eq("filing_type", "8-K")
        .eq("period", existingQuarter);
      if ((existingAnalysis.data?.[0] as { cards?: unknown } | undefined)?.cards && f.accessionNumber !== forceAccession) {
        console.log(`[filing-analysis-stage-a] ${sym} ${existingQuarter} (${f.accessionNumber}, filed ${f.filingDate}): already captured with cards — SKIPPING`);
        continue;
      }
      if (f.accessionNumber === forceAccession) {
        console.log(`[filing-analysis-stage-a] ${sym} ${existingQuarter} (${f.accessionNumber}, filed ${f.filingDate}): --force-accession override — re-running despite existing cards`);
      }
    }

    console.log(`[filing-analysis-stage-a] ${sym} ${f.accessionNumber} (filed ${f.filingDate}): capturing…`);
    const captured = await captureStageAReleaseForSymbol(sym, { accessionNumber: f.accessionNumber, nearFilingDateHint: f.filingDate });
    if (!captured.ok) {
      const o = captured.outcome;
      console.log(`[filing-analysis-stage-a] RESULT: ${sym} ${f.filingDate} — no_release_found (reason=${o.outcome === "no_release_found" ? o.reason : "?"}) — ${o.outcome === "no_release_found" ? o.detail : "unknown"}`);
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${sym} ${captured.quarter}: release captured, pressText=${captured.pressText.length} chars, exhibit_source=${captured.exhibitSource}`);
    const nearest = captured.nearestMatch;
    const linkNote = captured.linkedEarningsHistoryId
      ? `LINKED id=${captured.linkedEarningsHistoryId}`
      : nearest
        ? `found id=${nearest.id} (${nearest.dayDiff}d${nearest.uniqueAtDistance ? "" : ", tied"}) — NOT linked`
        : "no matching earnings_history row within 5 days";
    console.log(`[filing-analysis-stage-a] ${sym} ${captured.quarter}: earnings_history: ${linkNote}`);

    const notesPrefix = `auto: filing-analysis-stage-a v1 [--backfill-symbol], ${sym} ${captured.quarter}, earnings_history_id=${captured.linkedEarningsHistoryId ?? (nearest ? `${nearest.id} (found, not linked)` : "none")}, exhibit_source=${captured.exhibitSource}`;
    const outcome = await runCardsPipeline({
      sb,
      symbol: sym,
      quarter: captured.quarter,
      filingDate: captured.filingDate,
      pressText: captured.pressText,
      notesPrefix,
      accessionNumber: captured.accessionNumber,
    });
    if (outcome.status === "captured") {
      console.log(`[filing-analysis-stage-a] RESULT: ${sym} ${captured.quarter} CAPTURED — ${outcome.countsSummary}, dropped=${outcome.droppedCount}, basis_defaulted=${outcome.basisDefaultedCount}`);
      if (outcome.droppedDetail.length > 0) {
        console.log(`[filing-analysis-stage-a]   DROPPED: ${outcome.droppedDetail.join(" | ")}`);
      }
      if (outcome.basisDefaultedDetail.length > 0) {
        console.log(`[filing-analysis-stage-a]   BASIS DEFAULTED: ${outcome.basisDefaultedDetail.join(" | ")}`);
      }
    } else {
      console.log(`[filing-analysis-stage-a] RESULT: ${sym} ${captured.quarter} — ${outcome.status}: ${outcome.detail}`);
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry");
  const symbolArg = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1];
  const forceSymbolArg = process.argv.find((a) => a.startsWith("--force-symbol="))?.split("=")[1];
  const backfillSymbolArg = process.argv.find((a) => a.startsWith("--backfill-symbol="))?.split("=")[1];
  if (forceSymbolArg) {
    await runForceSymbol(forceSymbolArg);
    return;
  }
  if (backfillSymbolArg) {
    const quartersArg = process.argv.find((a) => a.startsWith("--quarters="))?.split("=")[1];
    const quarters = quartersArg ? Number.parseInt(quartersArg, 10) : 4;
    const forceAccession = process.argv.find((a) => a.startsWith("--force-accession="))?.split("=")[1];
    await runBackfillSymbol(backfillSymbolArg, quarters, forceAccession);
    return;
  }
  const { selectStageACandidates, selectStageACandidateBySymbol, captureStageARelease, isLastStageARetryDay } =
    await import("../lib/filing-analysis-capture");
  const { createServerClient } = await import("../lib/supabase");
  const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");

  const todayEt = todayEasternIso();
  const startClock = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const startPost = await sendDiscordAlert(
    `🔵 ${startClock} — Earnings Reports Stage A courier starting${dryRun ? " [dry run]" : ""}`,
    { mention: false, returnId: true },
  );
  const startMessageId = startPost.ok ? startPost.messageId : undefined;

  const candidates = symbolArg
    ? [await selectStageACandidateBySymbol(symbolArg)].filter((c): c is NonNullable<typeof c> => c !== null)
    : await selectStageACandidates(todayEt);
  console.log(`[filing-analysis-stage-a] ${todayEt}: ${candidates.length} candidate(s): ${candidates.map((c) => c.symbol).join(", ") || "(none)"}${symbolArg ? ` [--symbol=${symbolArg} override]` : ""}`);

  const results: RunResult[] = [];
  const sb = createServerClient();

  for (const candidate of candidates) {
    if (elapsedSeconds() * 1000 > RUN_BUDGET_MS) {
      console.warn(`[filing-analysis-stage-a] budget exhausted, ${candidates.length - results.length} candidate(s) deferred to next run`);
      break;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: capturing release…`);
    const captured = await captureStageARelease(candidate);
    if (!captured.ok) {
      const o = captured.outcome;
      if (o.outcome === "no_release_found" && o.reason === "not_yet_filed" && !isLastStageARetryDay(candidate.earningsDate, todayEt)) {
        // Expected state for a same-week reporter — the 8-K hasn't
        // posted yet. Log only; will retry tomorrow within the window.
        console.log(`[filing-analysis-stage-a] ${candidate.symbol}: pending — not yet filed, retries through ${candidate.earningsDate}`);
        results.push({ symbol: candidate.symbol, status: "pending", detail: "not yet filed", pingWorthy: false });
        continue;
      }
      const detail = o.outcome === "no_release_found" ? o.detail : `unexpected outcome: ${o.outcome}`;
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: ${o.outcome} — ${detail}`);
      results.push({ symbol: candidate.symbol, status: "no_release_found", detail, pingWorthy: true });
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: release captured (${candidate.symbol} ${captured.quarter}), pressText=${captured.pressText.length} chars, exhibit_source=${captured.exhibitSource}`);

    if (dryRun) {
      console.log(`[filing-analysis-stage-a] ${candidate.symbol}: dry run — skipping claude -p and DB write`);
      continue;
    }

    const notesPrefix = `auto: filing-analysis-stage-a v1, ${candidate.symbol} ${captured.quarter}, earnings_history_id=${candidate.earningsHistoryId}, exhibit_source=${captured.exhibitSource}`;
    const outcome = await runCardsPipeline({
      sb,
      symbol: candidate.symbol,
      quarter: captured.quarter,
      filingDate: captured.filingDate,
      pressText: captured.pressText,
      notesPrefix,
      accessionNumber: captured.accessionNumber,
    });
    if (outcome.status !== "captured") {
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: ${outcome.status} — ${outcome.detail}`);
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: outcome.status, detail: outcome.detail, pingWorthy: true });
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: filing_analyses row written (${outcome.analysisChars} chars), ${outcome.countsSummary}, dropped=${outcome.droppedCount}`);
    results.push({
      symbol: candidate.symbol,
      quarter: captured.quarter,
      status: "captured",
      analysisChars: outcome.analysisChars,
      countsSummary: outcome.countsSummary,
      droppedCount: outcome.droppedCount,
      droppedDetail: outcome.droppedDetail,
      pingWorthy: outcome.droppedCount > 0,
    });
  }

  const capturedCount = results.filter((r) => r.status === "captured").length;
  const pendingCount = results.filter((r) => r.status === "pending").length;
  const totalDropped = results.reduce((n, r) => (r.status === "captured" ? n + r.droppedCount : n), 0);
  const needsAttention = results.some((r) => r.pingWorthy);
  const summaryLines = results.length === 0
    ? ["no candidates"]
    : results.map((r) => {
        if (r.status === "captured") {
          const dropNote = r.droppedCount > 0 ? ` ⚠️ ${r.droppedCount} dropped: ${r.droppedDetail.join("; ")}` : "";
          return `${r.symbol} ✅ (${r.analysisChars} chars, ${r.countsSummary})${dropNote}`;
        }
        if (r.status === "pending") return `${r.symbol} ⏳ pending — not yet filed`;
        return `${r.symbol} ⚠️ ${r.status}: ${r.detail}`;
      });
  const summary = summaryLines.join("\n");
  const leadIcon = dryRun
    ? "🔵 [dry run] "
    : needsAttention
      ? "⚠️ "
      : results.length === 0
        ? "⚪ "
        : pendingCount === results.length
          ? "⏳ "
          : "✅ ";
  const finalText = `${leadIcon}Earnings Reports Stage A — ${elapsedSeconds().toFixed(1)}s, ${candidates.length} candidate(s), ${capturedCount} captured${pendingCount > 0 ? `, ${pendingCount} pending` : ""}${totalDropped > 0 ? `, ${totalDropped} card(s) dropped` : ""}\n${summary}`;
  console.log(`[filing-analysis-stage-a] ${finalText.replace(/\n/g, " | ")}`);
  if (startMessageId) {
    const editRes = await editDiscordAlert(startMessageId, finalText, { mention: needsAttention });
    if (!editRes.ok) await sendDiscordAlert(finalText, { mention: needsAttention });
  } else {
    await sendDiscordAlert(finalText, { mention: needsAttention });
  }
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[filing-analysis-stage-a] fatal: ${msg}`);
  try {
    const { sendDiscordAlert } = await import("../lib/discord-alert");
    await sendDiscordAlert(`🔴 Earnings Reports Stage A courier — fatal: ${msg}`);
  } catch {
    /* best effort */
  }
  process.exit(1);
});
