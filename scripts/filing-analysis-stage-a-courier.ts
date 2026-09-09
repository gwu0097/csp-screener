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

// pingWorthy distinguishes "log it, don't page" from "this needs a
// look" (2026-09-09, per the COO false-alert review — same reasoning
// as the T1 corrupted-baseline detector: an alert firing on the
// expected, non-broken state trains the channel to be ignored).
// - captured: never pings, success.
// - pending: "not_yet_filed" and still inside the retry window — the
//   8-K legitimately doesn't exist yet for a same-week reporter.
//   Routine, logged only.
// - no_release_found (every other reason) / claude_failed /
//   invalid_output / write_failed: always pings — something that WAS
//   available failed to process, or the retry window is closing with
//   still nothing found.
type RunResult =
  | { symbol: string; quarter: string; status: "captured"; analysisChars: number; pingWorthy: false }
  | { symbol: string; quarter?: string; status: "pending"; detail: string; pingWorthy: false }
  | {
      symbol: string;
      quarter?: string;
      status: "no_release_found" | "claude_failed" | "invalid_output" | "write_failed";
      detail: string;
      pingWorthy: true;
    };

// --force-symbol=SYM: manual diagnostic run against a symbol regardless
// of earnings_history/candidate-window state — same shape as the
// existing manual "Fetch latest 8-K" UI button (no earnings_history
// dependency, no attempt logging), plus the claude -p analysis Stage A
// adds. Never writes an earnings_history_id link — a candidate found
// this way is reported, not attached, since guessing the link outside
// the normal selectStageACandidates path is exactly what that column
// was added to avoid. No Discord post — this is a manual, watched run,
// not an unattended one.
async function runForceSymbol(symbol: string): Promise<void> {
  const { captureStageAReleaseForSymbol, findNearestEarningsHistoryRow } = await import(
    "../lib/filing-analysis-capture"
  );
  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();

  console.log(`[filing-analysis-stage-a] --force-symbol=${symbol}: capturing release (bypassing candidate selection)…`);
  const captured = await captureStageAReleaseForSymbol(symbol);
  if (!captured.ok) {
    const o = captured.outcome;
    console.log(`[filing-analysis-stage-a] RESULT: no_release_found (reason=${o.outcome === "no_release_found" ? o.reason : "?"}) — ${o.outcome === "no_release_found" ? o.detail : "unknown"}`);
    return;
  }
  console.log(`[filing-analysis-stage-a] release captured: ${symbol} ${captured.quarter}, filed ${captured.filingDate}, pressText=${captured.pressText.length} chars`);

  const nearest = await findNearestEarningsHistoryRow(symbol, captured.filingDate);
  console.log(
    nearest
      ? `[filing-analysis-stage-a] earnings_history: found id=${nearest.id} earnings_date=${nearest.earningsDate} (${nearest.dayDiff}d from filing date) — NOT linked (bypassed candidate selection)`
      : `[filing-analysis-stage-a] earnings_history: no row within 5 days of ${captured.filingDate} — no matching row exists`,
  );

  const prompt = buildPrompt(symbol, captured.quarter, captured.pressText);
  const callStart = Date.now();
  let claudeOut: string;
  try {
    claudeOut = execFileSync(CLAUDE_BIN, ["-p", prompt, "--allowedTools", ""], {
      encoding: "utf8",
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[filing-analysis-stage-a] RESULT: claude_failed — ${msg}`);
    return;
  }
  const callSeconds = (Date.now() - callStart) / 1000;
  console.log(`[filing-analysis-stage-a] claude -p returned in ${callSeconds.toFixed(1)}s, ${claudeOut.length} chars`);

  const valid = looksLikeValidAnalysis(claudeOut);
  if (!valid.ok) {
    console.log(`[filing-analysis-stage-a] RESULT: invalid_output — ${valid.reason} — NOT writing to filing_analyses`);
    return;
  }

  const analysisText = claudeOut.trim();
  const notes = `auto: filing-analysis-stage-a v1 [--force-symbol diagnostic], ${symbol} ${captured.quarter}, earnings_history_id=${nearest ? nearest.id : "none"}, pressText_chars=${captured.pressText.length}, claude_call_s=${callSeconds.toFixed(1)}`;
  const ins = await sb.from("filing_analyses").insert({
    symbol: symbol.toUpperCase(),
    filing_type: "8-K",
    period: captured.quarter,
    filing_date: captured.filingDate,
    analysis_text: analysisText,
    notes,
  });
  if (ins.error) {
    console.log(`[filing-analysis-stage-a] RESULT: write_failed — ${ins.error.message}`);
    return;
  }
  console.log(`[filing-analysis-stage-a] RESULT: captured — filing_analyses row written (${analysisText.length} chars)`);
}

async function main() {
  const dryRun = process.argv.includes("--dry");
  const symbolArg = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1];
  const forceSymbolArg = process.argv.find((a) => a.startsWith("--force-symbol="))?.split("=")[1];
  if (forceSymbolArg) {
    await runForceSymbol(forceSymbolArg);
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
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "claude_failed", detail: msg, pingWorthy: true });
      continue;
    }
    const callSeconds = (Date.now() - callStart) / 1000;
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: claude -p returned in ${callSeconds.toFixed(1)}s, ${claudeOut.length} chars`);

    const valid = looksLikeValidAnalysis(claudeOut);
    if (!valid.ok) {
      console.warn(`[filing-analysis-stage-a] ${candidate.symbol}: output rejected — ${valid.reason}`);
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "invalid_output", detail: valid.reason ?? "unknown", pingWorthy: true });
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
      results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "write_failed", detail: ins.error.message, pingWorthy: true });
      continue;
    }
    console.log(`[filing-analysis-stage-a] ${candidate.symbol}: filing_analyses row written (${analysisText.length} chars)`);
    results.push({ symbol: candidate.symbol, quarter: captured.quarter, status: "captured", analysisChars: analysisText.length, pingWorthy: false });
  }

  const captured = results.filter((r) => r.status === "captured").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const needsAttention = results.some((r) => r.pingWorthy);
  const summary = results.length === 0
    ? "no candidates"
    : results
        .map((r) =>
          r.status === "captured"
            ? `${r.symbol} ✅ (${r.analysisChars} chars)`
            : r.status === "pending"
              ? `${r.symbol} ⏳ pending — not yet filed`
              : `${r.symbol} ⚠️ ${r.status}: ${r.detail}`,
        )
        .join("\n");
  // Lead icon reflects the most severe thing in this run: any
  // ping-worthy result wins over an all-pending or all-captured run,
  // which wins over an empty candidate list.
  const leadIcon = dryRun
    ? "🔵 [dry run] "
    : needsAttention
      ? "⚠️ "
      : results.length === 0
        ? "⚪ "
        : pending === results.length
          ? "⏳ "
          : "✅ ";
  const finalText = `${leadIcon}Earnings Reports Stage A — ${elapsedSeconds().toFixed(1)}s, ${candidates.length} candidate(s), ${captured} captured${pending > 0 ? `, ${pending} pending` : ""}\n${summary}`;
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
