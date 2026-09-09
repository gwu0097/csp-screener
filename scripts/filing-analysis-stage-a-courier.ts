// Earnings Reports Stage A courier. Runs headless Claude Code (the
// user's Claude subscription, no API key — same mechanism proven by
// scripts/robinhood-courier.ts) to read an 8-K earnings-release exhibit
// whole (inline argv prompt, no tool calls — see the 2026-09-09 design
// review: 17-20s for a full 10-Q this size, this is a fraction of that)
// and produce the guidance-range / management-commentary half of the
// Earnings Reports analysis. Items 3-4 (litigation/subsequent-events,
// what-changed-vs-last-quarter) are Stage B, once the 10-Q lands — not
// built yet.
//
// Run via a dedicated launchd agent (not yet created/loaded — this
// script is meant to be run manually first to confirm one real pass
// end to end), once daily, weekdays. Usage: npx tsx
// scripts/filing-analysis-stage-a-courier.ts [--dry]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

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
const CLAUDE_TIMEOUT_MS = 120_000; // generous vs. the ~17-20s measured for a much larger document
const RUN_BUDGET_MS = 600_000; // stop starting new candidates past this, matches T0/T1's per-run budget philosophy

function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function buildPrompt(symbol: string, quarter: string, pressText: string): string {
  return `You are producing part of a post-mortem "Earnings Reports" entry for a long-term stock holder — NOT a pre-trade research pitch. The reader already knows the raw numbers (revenue, EPS, margins are shown elsewhere); your job is the qualitative half of ONE quarter's picture: ${symbol} ${quarter}.

Answer exactly two things, each as its own labeled section. Be specific and cite real figures/dates from the text — do not paraphrase into vague language. If something isn't disclosed in this document, say so explicitly as "Not disclosed in this release" — that is a valid, required answer, not something to omit or guess around.

=== GUIDANCE ===
Next quarter's (and full-year, if given) guided range exactly as stated — the actual numbers/percentages, not just "guidance was raised." If the release compares to previous guidance, state both. If no guidance is given in this document, say so explicitly.

=== COMMENTARY ===
Management's own characterization of demand this quarter — tone, and specifically what they attribute the results to (a named product, a macro factor, a customer segment, pricing, etc.), in their own words where it matters. Two or three sentences. Not a general summary of the whole release — only the demand/attribution framing.

This analysis is INCOMPLETE by design — litigation/subsequent-events and the quarter-over-quarter comparison are added later once the 10-Q filing lands (days after this release). Do not attempt those here and do not apologize for their absence; just answer GUIDANCE and COMMENTARY.

Press release text (SEC EDGAR, live-fetched, HTML-stripped):

${pressText}`;
}

// Reject anything that doesn't look like a real answer before it ever
// reaches filing_analyses — catches a claude -p call that errored,
// refused, or returned something degenerate, distinct from the input-side
// MIN_EXHIBIT_CHARS guard in lib/filing-analysis-capture.ts.
function looksLikeValidAnalysis(text: string): { ok: boolean; reason?: string } {
  const trimmed = text.trim();
  if (trimmed.length < 200) return { ok: false, reason: `too short (${trimmed.length} chars)` };
  if (!/GUIDANCE/i.test(trimmed) || !/COMMENTARY/i.test(trimmed)) {
    return { ok: false, reason: "missing required GUIDANCE/COMMENTARY sections" };
  }
  const refusalMarkers = [
    "i cannot", "i can't", "i'm not able to", "as an ai",
  ];
  const head = trimmed.slice(0, 300).toLowerCase();
  if (refusalMarkers.some((m) => head.includes(m))) {
    return { ok: false, reason: "response reads as a refusal" };
  }
  return { ok: true };
}

type RunResult =
  | { symbol: string; quarter: string; status: "captured"; analysisChars: number }
  | { symbol: string; quarter?: string; status: "no_release_found" | "claude_failed" | "invalid_output" | "write_failed"; detail: string };

async function main() {
  const dryRun = process.argv.includes("--dry");
  const symbolArg = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1];
  const { selectStageACandidates, selectStageACandidateBySymbol, captureStageARelease } = await import(
    "../lib/filing-analysis-capture"
  );
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
      // no_release_found covers every pre-write failure, including a
      // too-short document (result.error then reads "Press release
      // exhibit too short (N chars, floor 3000)") — see
      // lib/filing-analysis-capture.ts's MIN_EXHIBIT_CHARS comment for
      // why that check has to happen before fetchAndStoreEarningsRelease
      // writes anything, not after.
      const detail = o.outcome === "no_release_found" ? o.detail : `unexpected outcome: ${o.outcome}`;
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: ${o.outcome} — ${detail}`);
      results.push({ symbol: candidate.symbol, status: "no_release_found", detail });
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: release captured (${candidate.symbol} ${captured.quarter}), pressText=${captured.pressText.length} chars`);

    if (dryRun) {
      console.log(`[filing-analysis-stage-a] ${candidate.symbol}: dry run — skipping claude -p and DB write`);
      continue;
    }

    const prompt = buildPrompt(candidate.symbol, captured.quarter, captured.pressText);
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
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: claude -p failed after ${((Date.now() - callStart) / 1000).toFixed(1)}s: ${msg}`);
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "claude_failed", detail: msg });
      continue;
    }
    const callSeconds = (Date.now() - callStart) / 1000;
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: claude -p returned in ${callSeconds.toFixed(1)}s, ${claudeOut.length} chars`);

    const valid = looksLikeValidAnalysis(claudeOut);
    if (!valid.ok) {
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: output rejected — ${valid.reason}`);
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "invalid_output", detail: valid.reason ?? "unknown" });
      continue;
    }

    const analysisText = claudeOut.trim();
    const notes = `auto: filing-analysis-stage-a v1, ${candidate.symbol} ${captured.quarter}, earnings_history_id=${candidate.earningsHistoryId}, pressText_chars=${captured.pressText.length}, claude_call_s=${callSeconds.toFixed(1)}`;
    const ins = await sb.from("filing_analyses").insert({
      symbol: candidate.symbol,
      filing_type: "8-K",
      period: captured.quarter,
      filing_date: captured.filingDate,
      analysis_text: analysisText,
      notes,
    });
    if (ins.error) {
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: filing_analyses insert failed: ${ins.error.message}`);
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "write_failed", detail: ins.error.message });
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: filing_analyses row written (${analysisText.length} chars)`);
    results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "captured", analysisChars: analysisText.length });
  }

  const captured = results.filter((r) => r.status === "captured").length;
  const summary = results.length === 0
    ? "no candidates"
    : results.map((r) => r.status === "captured" ? `${r.symbol} ✅ (${r.analysisChars} chars)` : `${r.symbol} ⚠️ ${r.status}: ${r.detail}`).join("\n");
  const finalText = `${dryRun ? "🔵 [dry run] " : captured === results.length && results.length > 0 ? "✅ " : results.length === 0 ? "⚪ " : "⚠️ "}Earnings Reports Stage A — ${elapsedSeconds().toFixed(1)}s, ${candidates.length} candidate(s), ${captured} captured\n${summary}`;
  console.log(`[filing-analysis-stage-a] ${finalText.replace(/\n/g, " | ")}`);
  if (startMessageId) {
    const editRes = await editDiscordAlert(startMessageId, finalText, { mention: captured < results.length });
    if (!editRes.ok) await sendDiscordAlert(finalText, { mention: captured < results.length });
  } else {
    await sendDiscordAlert(finalText, { mention: captured < results.length });
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
