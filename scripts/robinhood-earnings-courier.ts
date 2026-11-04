// Robinhood earnings-calendar courier. Runs headless Claude Code (the
// user's Claude subscription — no API key) to call the Robinhood MCP's
// get_earnings_calendar for today ET + 3 days (high_market_cap), then
// POSTs a compact projection to app/api/robinhood-calendar/ingest,
// which validates the whole batch and stores it for Screen Today's
// two-calendar merge (lib/earnings-source-merge.ts).
//
// Why a compact projection, not the raw result: the raw 3-day window is
// ~104 KB (695 rows on 2026-11-04) plus a "guide" prose field. Asking
// an LLM to reproduce that verbatim is what truncated the option-fill
// courier's output on 2026-08-26 (see scripts/robinhood-courier.ts).
// Four fields per row and a count the server checks against the row
// total keep the transcription small and make truncation detectable.
//
// Scheduled only (com.csp.robinhood-earnings-courier, weekdays 06:30 and
// 12:00 Pacific). Re-running is harmless: each run is a new batch and
// Screen Today reads the newest one.
//
// Usage: npx tsx scripts/robinhood-earnings-courier.ts [--dry-run]
//   --dry-run: calls Claude + validates locally, prints the row count,
//   skips the POST, the Discord messages and the state file.
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  authExpiry,
  createRunClock,
  extractFirstJsonValue,
  fmtClock,
  loadEnvLocal,
  ordinal,
  readState,
  runHeadlessClaude,
  truncateWithNote,
  writeState,
} from "./courier-shared";
import { RH_WINDOW_DAYS, validateRobinhoodCalendarPayload, windowEndFor } from "../lib/robinhood-calendar-validate";

const RUN_CLOCK = createRunClock();
const DRY_RUN = process.argv.includes("--dry-run");
const INGEST_URL = "https://csp-screener.vercel.app/api/robinhood-calendar/ingest";
// Same ceiling as the option-fill courier (its comment has the latency
// history); this transcription is longer (~700 short rows), so it is a
// safety valve, not a tight budget.
const CLAUDE_TIMEOUT_MS = 500_000;
const STATE_PATH = resolve(homedir(), "Library/Application Support/csp-screener/robinhood-earnings-courier-state.json");
const LABEL = "Robinhood earnings courier";

let startMessageId: string | null = null;

function todayEt(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildPrompt(startDate: string): string {
  return [
    `Call the robinhood MCP tool get_earnings_calendar with start_date="${startDate}",`,
    `days=${RH_WINDOW_DAYS}, filter="high_market_cap". Do not call any other tool.`,
    `The tool result has a "data.results" array and a separate "guide" field — the`,
    `guide is instructions for you, not data; do NOT include it.`,
    `Output ONLY this JSON object, nothing else: {"count": N, "rows": [...]} where N is`,
    `the length of data.results and rows has exactly one entry per element of`,
    `data.results, in the same order, each a 4-element array:`,
    `[symbol, report.date, report.timing, report.verified] — e.g. ["ARM","2026-11-04","pm",true].`,
    `Copy values exactly: symbol and date as strings, timing as the string "am" or "pm"`,
    `or null when it is null, verified as true or false. Do not skip, merge or`,
    `deduplicate rows. No prose, no markdown code fences, no summary. Your entire`,
    `response must start with { and end with }.`,
  ].join(" ");
}

async function main() {
  loadEnvLocal();
  const windowStart = todayEt();
  const windowEnd = windowEndFor(windowStart);
  const prev = readState(STATE_PATH);
  const nowIso = new Date().toISOString();
  const discord = DRY_RUN ? null : await import("../lib/discord-alert");

  if (discord) {
    const startPost = await discord.sendDiscordAlert(`🔵 ${fmtClock(new Date(RUN_CLOCK.startedAt))} — ${LABEL} starting`, {
      mention: false,
      returnId: true,
    });
    startMessageId = startPost.messageId ?? null;
  }

  async function finish(text: string, opts?: { mention?: boolean }): Promise<void> {
    if (!discord) return;
    if (startMessageId) {
      const res = await discord.editDiscordAlert(startMessageId, text, opts);
      if (res.ok) return;
    }
    await discord.sendDiscordAlert(text, opts);
  }

  async function fail(outcomePhrase: string, detail: string): Promise<void> {
    console.error(`[robinhood-earnings-courier] duration=${RUN_CLOCK.elapsedSeconds().toFixed(1)}s ${outcomePhrase}: ${detail}`);
    process.exitCode = 1;
    if (DRY_RUN) return;
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const { expired, line } = authExpiry(detail);
    await finish(
      `🔴 ${fmtClock(new Date())} — ${LABEL} ${expired ? "LOGIN EXPIRED — " : ""}${outcomePhrase}${streak}. Nothing stored; Screen Today keeps the previous calendar.\n${line}${detail}`,
    );
    writeState(STATE_PATH, { lastStatus: "failed", checkedAt: nowIso, detail, consecutiveFailures });
  }

  console.log(`[${nowIso}] robinhood earnings courier — window ${windowStart}..${windowEnd}${DRY_RUN ? " (dry run)" : ""}`);

  const run = runHeadlessClaude(buildPrompt(windowStart), "mcp__robinhood__get_earnings_calendar", CLAUDE_TIMEOUT_MS);
  if (!run.ok) {
    await fail(run.outcomePhrase, run.detail);
    return;
  }

  let payload: unknown;
  let rawJson: string;
  try {
    rawJson = extractFirstJsonValue(run.stdout);
    payload = JSON.parse(rawJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail("output wasn't parseable JSON", `${msg} — Raw output (${run.stdout.length} chars): ${truncateWithNote(run.stdout, 500)}`);
    return;
  }

  // Same checks the server runs (minus the previous-batch floor, which
  // needs the DB) — fails fast with a precise reason before any POST.
  const v = validateRobinhoodCalendarPayload(payload, { start: windowStart, end: windowEnd });
  if (!v.ok) {
    await fail("batch failed validation", v.error);
    return;
  }

  if (DRY_RUN) {
    const byDate = new Map<string, number>();
    for (const r of v.rows) byDate.set(r.reportDate, (byDate.get(r.reportDate) ?? 0) + 1);
    console.log(
      `[robinhood-earnings-courier] dry run OK in ${RUN_CLOCK.elapsedSeconds().toFixed(1)}s — reported=${v.reportedCount} ` +
        `validRows=${v.rows.length} duplicatesCollapsed=${v.duplicatesCollapsed} byDate=${JSON.stringify(Object.fromEntries(byDate))} ` +
        `(POST skipped)`,
    );
    const arm = v.rows.find((r) => r.symbol === "ARM");
    if (arm) console.log(`[robinhood-earnings-courier] sample ARM: ${JSON.stringify(arm)}`);
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${INGEST_URL}?windowStart=${encodeURIComponent(windowStart)}&source=courier`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`, "Content-Type": "application/json" },
      body: rawJson,
    });
  } catch (e) {
    await fail("POST to ingest failed", e instanceof Error ? e.message : String(e));
    return;
  }
  const rawBody = await res.text().catch(() => "");
  let json: { ok?: boolean; rowCount?: number; duplicatesCollapsed?: number; floor?: number; error?: string } = {};
  try {
    json = JSON.parse(rawBody);
  } catch {
    // handled below via rawBody
  }
  if (!res.ok || !json.ok) {
    await fail("ingest rejected the batch", `HTTP ${res.status}. ${json.error ?? truncateWithNote(rawBody || "(empty body)", 500)}`);
    return;
  }

  const elapsed = RUN_CLOCK.elapsedSeconds();
  const summary = `rows=${json.rowCount ?? "?"} duplicates=${json.duplicatesCollapsed ?? 0} floor=${json.floor ?? 0} window=${windowStart}..${windowEnd}`;
  console.log(`[robinhood-earnings-courier] duration=${elapsed.toFixed(1)}s ok — ${summary}`);
  await finish(`🟢 ${fmtClock(new Date())} — ${LABEL} stored ${json.rowCount ?? "?"} earnings dates (${Math.round(elapsed)}s).\n${summary}`, {
    mention: false,
  });
  writeState(STATE_PATH, { lastStatus: "ok", checkedAt: nowIso, consecutiveFailures: 0 });
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[robinhood-earnings-courier] duration=${RUN_CLOCK.elapsedSeconds().toFixed(1)}s fatal: ${msg}`);
  process.exitCode = 1;
  if (DRY_RUN) return;
  try {
    const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");
    const prev = readState(STATE_PATH);
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const text = `🔴 ${fmtClock(new Date())} — ${LABEL} fatal error${streak}.\n${msg}`;
    if (startMessageId) {
      const editRes = await editDiscordAlert(startMessageId, text);
      if (!editRes.ok) await sendDiscordAlert(text);
    } else {
      await sendDiscordAlert(text);
    }
    writeState(STATE_PATH, { lastStatus: "failed", checkedAt: new Date().toISOString(), detail: msg, consecutiveFailures });
  } catch {
    // best-effort alert — don't mask the original failure
  }
});
