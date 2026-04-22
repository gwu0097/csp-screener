import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // VLM calls can be slow

// Screenshot parsing is powered by Google Gemini vision. MINIMAX_API_KEY is
// retained in the env but intentionally unused here (prior attempts hit
// model-availability + JSON-format issues). Gemini's key lives in the URL
// query string, not in a header.
//
// Model fallback: gemini-1.5-flash is the stable id most projects have
// access to; -latest alias is tried next in case the plain name isn't
// resolved for this key. We walk the list until one returns 2xx.
const GEMINI_MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-latest"];
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";

function geminiUrl(model: string): string {
  return `${GEMINI_ENDPOINT_BASE}/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
}

// Redact the key for logs — the URL structure is useful to debug, the key
// is not. Replace the value portion of ?key=... with *** so accidental log
// sharing doesn't leak the credential.
function redactUrl(url: string): string {
  return url.replace(/(key=)[^&]+/, "$1***");
}

// The exact field contract the caller will see. Mirrors the spec prompt so
// the review table has predictable columns.
export type ParsedTrade = {
  symbol: string;
  action: "open" | "close";
  contracts: number;
  strike: number;
  expiry: string; // YYYY-MM-DD
  optionType: "put" | "call";
  premium: number;
  broker: string;
};

const PROMPT = `This is a screenshot of a ThinkorSwim (ThinkOrSwim) brokerage order history table. The table has colored rows (red for SELL/open, green for BUY/close).

Column headers are: Time Placed, Spread, Side, QtyPos Effect, Symbol, Exp, StrikeType, Price, TIF, Status

Extract every filled options trade row. Ignore stock trades (where StrikeType says 'STOCK' or 'ETF').

For each options row:
- action: if Side=SELL and QtyPos Effect contains 'TO OPEN' → 'open'
         if Side=BUY and QtyPos Effect contains 'TO CLOSE' → 'close'
- contracts: the number before 'TO OPEN' or 'TO CLOSE' (ignore the +/- sign)
- symbol: the ticker in the Symbol column (e.g. NOW, GE, TSLA)
- strike: the number before PUT or CALL in StrikeType column
- optionType: 'put' or 'call' from StrikeType column
- expiry: convert the Exp date to YYYY-MM-DD format
- premium: the Price column value

Return ONLY a JSON array, no explanation, no markdown.`;

// Try to pull structured data out of an LLM response. Models wrap their
// output inconsistently — plain JSON, ```json fences, generic ``` fences,
// prose-then-array, smart quotes, trailing commas, single-object instead of
// array. Walks a prioritized cascade; returns both the parsed value and the
// method that worked so we can log which shape the model produced.
type ExtractResult =
  | { ok: true; data: unknown; method: string }
  | { ok: false };

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitize(text: string): string {
  return text
    // Smart quotes → straight
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Trailing commas before ] or }
    .replace(/,\s*([\]}])/g, "$1")
    // Strip stray BOM / zero-width
    .replace(/[﻿​]/g, "");
}

function extractJsonFromText(text: string): ExtractResult {
  const trimmed = text.trim();

  // 1. Direct parse — happens when the model actually returned pure JSON.
  const direct = tryParse(trimmed);
  if (direct !== undefined) return { ok: true, data: direct, method: "direct" };

  // 2. ```json ... ``` fenced block.
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const inside = sanitize(jsonFence[1].trim());
    const parsed = tryParse(inside);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "json-fence" };
  }

  // 3. Any ``` ... ``` fence (no language tag).
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) {
    const inside = sanitize(anyFence[1].trim());
    const parsed = tryParse(inside);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "code-fence" };
  }

  // 4. Widest [...] substring — "outer" array. This tolerates prose before
  // or after the array (e.g. "Here are the trades: [ ... ]. Hope that helps.")
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const raw = arrayMatch[0];
    const parsed = tryParse(raw);
    if (parsed !== undefined) return { ok: true, data: parsed, method: "array-regex" };
    const sanitized = tryParse(sanitize(raw));
    if (sanitized !== undefined) return { ok: true, data: sanitized, method: "array-regex-sanitized" };
  }

  // 5. Widest {...} substring — single object. Wrap in an array so
  // downstream code treats it like the other shapes.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const parsed = tryParse(objMatch[0]);
    if (parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, data: [parsed], method: "object-regex-wrapped" };
    }
    const sanitized = tryParse(sanitize(objMatch[0]));
    if (sanitized !== undefined && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      return { ok: true, data: [sanitized], method: "object-regex-wrapped-sanitized" };
    }
  }

  return { ok: false };
}

function coerceTrade(raw: unknown, fallbackBroker: string): ParsedTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase().trim() : "";
  const action = r.action === "open" || r.action === "close" ? r.action : null;
  const optionType = r.optionType === "put" || r.optionType === "call" ? r.optionType : null;
  const contracts = Number(r.contracts);
  const strike = Number(r.strike);
  const premium = Number(r.premium);
  const expiry = typeof r.expiry === "string" ? r.expiry.slice(0, 10) : "";
  const broker = typeof r.broker === "string" && r.broker.trim() ? r.broker.toLowerCase() : fallbackBroker;
  if (!symbol || !action || !optionType) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(premium) || premium < 0) return null;
  return {
    symbol,
    action,
    contracts: Math.round(contracts),
    strike,
    expiry,
    optionType,
    premium,
    broker,
  };
}

// Gemini's vision API takes mime + base64 data as separate fields (no
// data URL prefix). Accept either a full data URL from the client or a raw
// base64 string for backwards compat. Vision APIs validate mime against the
// bytes, so the declared mime must match the real image format.
function normalizeImage(input: string): { mime: string; data: string; rawLen: number } {
  const match = input.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
  if (match) {
    return { mime: match[1], data: match[2], rawLen: match[2].length };
  }
  return { mime: "image/png", data: input, rawLen: input.length };
}

export async function POST(req: NextRequest) {
  console.log(`[parse-screenshot] GEMINI_API_KEY present: ${!!process.env.GEMINI_API_KEY}`);
  if (!GEMINI_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  let body: { image?: string; broker?: string };
  try {
    body = (await req.json()) as { image?: string; broker?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawImage = body.image ?? "";
  const broker = (body.broker ?? "schwab").toLowerCase();
  // Distinct from base64 length: the raw JSON field as received. If this
  // is 0/undefined, the client isn't actually sending anything.
  console.log(`[parse-screenshot] image bytes: ${rawImage ? rawImage.length : 0}`);
  if (!rawImage) return NextResponse.json({ error: "Missing image" }, { status: 400 });

  const { mime, data, rawLen } = normalizeImage(rawImage);
  console.log(
    `[parse-screenshot] broker=${broker} mime=${mime} base64_bytes=${rawLen}`,
  );

  const geminiBody = JSON.stringify({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mime, data } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2000,
    },
  });

  // Walk models in order; first 2xx wins. On 401/403 we bail (auth issue
  // no model change will fix). On other non-2xx, log + try next.
  let res: Response | null = null;
  const failures: string[] = [];
  for (const model of GEMINI_MODELS) {
    const url = geminiUrl(model);
    console.log(`[parse-screenshot] gemini url: ${redactUrl(url)}`);
    let attempt: Response;
    try {
      attempt = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: geminiBody,
        cache: "no-store",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[parse-screenshot] gemini network error (${model}): ${msg}`);
      failures.push(`${model} network: ${msg}`);
      continue;
    }
    if (attempt.ok) {
      console.log(`[parse-screenshot] gemini ok model=${model}`);
      res = attempt;
      break;
    }
    const errText = await attempt.text();
    console.error(`Gemini error ${model}: ${attempt.status} ${errText}`);
    failures.push(`${model} => ${attempt.status}: ${errText.slice(0, 200)}`);
    if (attempt.status === 401 || attempt.status === 403) {
      return NextResponse.json(
        { error: `Gemini auth failed (${attempt.status}). Check GEMINI_API_KEY. ${errText.slice(0, 300)}` },
        { status: 502 },
      );
    }
  }

  if (!res) {
    return NextResponse.json(
      { error: `All Gemini attempts failed. ${failures.join(" | ").slice(0, 800)}` },
      { status: 502 },
    );
  }

  try {
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };
    // Gemini can split text across multiple parts — concatenate all of them.
    // Sometimes a safety block shows up as promptFeedback.blockReason instead
    // of a candidate, so surface that explicitly.
    if (json.promptFeedback?.blockReason) {
      console.error(`[parse-screenshot] gemini blocked: ${json.promptFeedback.blockReason}`);
      return NextResponse.json(
        { error: `Gemini blocked the request: ${json.promptFeedback.blockReason}` },
        { status: 502 },
      );
    }
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((p) => p?.text ?? "").join("").trim();
    if (!content) {
      const reason = json.candidates?.[0]?.finishReason ?? "no content";
      return NextResponse.json(
        { error: `Empty response from Gemini (${reason})` },
        { status: 502 },
      );
    }

    // Log the raw model output so we can see exactly what format it used.
    console.log(
      `[parse-screenshot] raw content (len=${content.length}): ${content.slice(0, 2000)}`,
    );

    const extracted = extractJsonFromText(content);
    if (!extracted.ok) {
      console.error(
        `[parse-screenshot] extraction failed — all methods exhausted. Full raw content: ${content}`,
      );
      return NextResponse.json(
        {
          error: `Could not parse model output as JSON. Raw model output: ${content.slice(0, 1500)}`,
        },
        { status: 502 },
      );
    }
    console.log(`[parse-screenshot] extracted via method=${extracted.method}`);

    let parsed: unknown = extracted.data;
    // Single-object shapes get wrapped so the rest of the pipeline treats
    // them uniformly with the array case.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed = [parsed];
    }
    if (!Array.isArray(parsed)) {
      return NextResponse.json(
        {
          error: `Model returned non-array/object JSON (${typeof parsed}). Raw: ${content.slice(0, 800)}`,
        },
        { status: 502 },
      );
    }

    const trades = parsed
      .map((r) => coerceTrade(r, broker))
      .filter((t): t is ParsedTrade => t !== null);

    // NB: model_trades is the array parsed from the model's response, not the
    // count of bytes received. If model_trades=0 we got a valid response
    // with no trades — check the logged raw content to see what the model
    // actually produced.
    console.log(
      `[parse-screenshot] broker=${broker} model_trades=${parsed.length} accepted=${trades.length}`,
    );
    return NextResponse.json({ trades });
  } catch (e) {
    console.error("[parse-screenshot] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Parse failed" },
      { status: 500 },
    );
  }
}
