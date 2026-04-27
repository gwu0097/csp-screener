// Harness: run the Gemini screenshot parser against a known-good test image.
// Mirrors the call shape in app/api/trades/parse-screenshot/route.ts so we
// can verify model behavior end-to-end without the Next server in the way.
//
//   node --env-file=.env.local --import=tsx test/test-screenshot.ts
//
// Shows raw Gemini output, the coerced ParsedTrade[], and counts.

import fs from "node:fs";
import path from "node:path";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const IMAGE_PATH = path.resolve("Test/test-screenshot.png");

const PROMPT = `This is a screenshot of a ThinkorSwim (ThinkOrSwim) brokerage order history table. The table has colored rows (red for SELL/open, green for BUY/close).

Column headers are: Time Placed, Spread, Side, QtyPos Effect, Symbol, Exp, StrikeType, Price, TIF, Status

Extract every filled options trade row. Ignore stock trades (StrikeType 'STOCK' or 'ETF') AND ignore rows where Status column says CANCELED or EXPIRED. Only include rows with Status exactly FILLED.

If Status = FILLED and the row is an option (not STOCK/ETF), you must include it. Count your FILLED rows before finalizing — do not skip any.

For each options row:
- action: if Side=SELL and QtyPos Effect contains 'TO OPEN' → 'open'
         if Side=BUY and QtyPos Effect contains 'TO CLOSE' → 'close'
- contracts: the number before 'TO OPEN' or 'TO CLOSE' (ignore the +/- sign)
- symbol: the ticker in the Symbol column (e.g. NOW, GE, TSLA)
- strike: the number before PUT or CALL in StrikeType column
- optionType: 'put' or 'call' from StrikeType column
- expiry: convert the Exp date to YYYY-MM-DD format
- premium: the Price column value
- timePlaced: YYYY-MM-DD from the Time Placed column (first column). Drop the time-of-day portion — date only.

Return ONLY a JSON array, no explanation, no markdown.

Extract EVERY row in the table. Do not stop early. There may be 10-30 rows. Return all of them.

The Price column shows values like '.60 LMT' or '7.15 LMT'. The premium is the numeric value only — strip the ' LMT' / ' MKT' suffix and return the result as a JSON number (not a string). '.60 LMT' becomes 0.60. Read the exact digits — do not substitute, round, or guess.`;

type ExtractResult = { ok: true; data: unknown; method: string } | { ok: false };

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function sanitize(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/[﻿​]/g, "");
}
function extractJsonFromText(text: string): ExtractResult {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return { ok: true, data: direct, method: "direct" };
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const inside = sanitize(jsonFence[1].trim());
    const parsed = tryParse(inside);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "json-fence" };
  }
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) {
    const inside = sanitize(anyFence[1].trim());
    const parsed = tryParse(inside);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "code-fence" };
  }
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const raw = arrayMatch[0];
    const parsed = tryParse(raw);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "array-regex" };
    const sanitized = tryParse(sanitize(raw));
    if (sanitized !== undefined) return { ok: true, data: sanitized, method: "array-regex-sanitized" };
  }
  return { ok: false };
}

async function main() {
  if (!GEMINI_KEY) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`Image not found at ${IMAGE_PATH}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(IMAGE_PATH);
  const base64 = buf.toString("base64");
  console.log(`Image: ${IMAGE_PATH} (${buf.length} bytes, base64 ${base64.length} chars)`);
  console.log(`Calling ${GEMINI_URL} model=${GEMINI_MODEL}...`);

  const t0 = Date.now();
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: "image/png", data: base64 } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  const elapsedMs = Date.now() - t0;
  console.log(`Gemini responded in ${elapsedMs}ms with status ${res.status}`);

  if (!res.ok) {
    const err = await res.text();
    console.error(`Gemini error body:\n${err}`);
    process.exit(1);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const finishReason = json.candidates?.[0]?.finishReason;
  const usage = json.usageMetadata;
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p) => p?.text ?? "").join("").trim();

  console.log(`\n=== finishReason: ${finishReason} ===`);
  console.log(`=== usage: promptTokens=${usage?.promptTokenCount} candidateTokens=${usage?.candidatesTokenCount} ===`);
  console.log(`\n=== raw Gemini response (len=${content.length}) ===`);
  console.log(content);

  const extracted = extractJsonFromText(content);
  if (!extracted.ok) {
    console.error("\n=== extraction FAILED ===");
    process.exit(1);
  }
  console.log(`\n=== extracted via method=${extracted.method} ===`);
  const trades = Array.isArray(extracted.data) ? extracted.data : [extracted.data];
  console.log(`\n=== parsed trades (count=${trades.length}) ===`);
  console.log(JSON.stringify(trades, null, 2));

  // Sanity breakdown
  const byAction = { open: 0, close: 0, other: 0 };
  const bySymbol = new Map<string, number>();
  const byDate = new Map<string, number>();
  for (const t of trades as Array<Record<string, unknown>>) {
    const act = String(t.action);
    if (act === "open") byAction.open += 1;
    else if (act === "close") byAction.close += 1;
    else byAction.other += 1;
    const sym = String(t.symbol ?? "?");
    bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + 1);
    const tp = String(t.timePlaced ?? "?");
    byDate.set(tp, (byDate.get(tp) ?? 0) + 1);
  }
  console.log(`\nBreakdown:`);
  console.log(`  action: open=${byAction.open} close=${byAction.close} other=${byAction.other}`);
  console.log(`  by symbol: ${Array.from(bySymbol.entries()).map(([s, n]) => `${s}=${n}`).join(", ")}`);
  console.log(`  by timePlaced: ${Array.from(byDate.entries()).map(([d, n]) => `${d}=${n}`).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
