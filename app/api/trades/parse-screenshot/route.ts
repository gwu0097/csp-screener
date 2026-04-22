import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // VLM calls can be slow

// Endpoints to try in order. Some accounts are provisioned on .io, most on
// .chat (note the trailing 'i' in minimaxi). We try both before giving up.
const MINIMAX_ENDPOINTS = [
  "https://api.minimaxi.chat/v1/chat/completions",
  "https://api.minimax.io/v1/chat/completions",
];
// Models to try in order. MiniMax-M2.7 is the current vision-capable default;
// M2.5 is the prior generation; abab6.5-chat is widely available on older
// plans (text-only — will 400 on image_url content, but worth the attempt as
// a last resort so the error message is unambiguous).
const MINIMAX_MODELS = ["MiniMax-M2.7", "MiniMax-M2.5", "abab6.5-chat"];
const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? "";

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

const PROMPT = `Extract all options trades from this brokerage screenshot. Return a JSON array only, no explanation. Each trade object must have these exact fields:
- symbol: string (ticker like TSLA, NOW, GE)
- action: 'open' or 'close' (SELL TO OPEN = open, BUY TO CLOSE = close)
- contracts: number (quantity of contracts)
- strike: number (strike price)
- expiry: string (YYYY-MM-DD format)
- optionType: 'put' or 'call'
- premium: number (price per contract)
- broker: string (infer from UI style if possible)

For Schwab QtyPos Effect column:
'-2 TO OPEN' means action=open, contracts=2
'+2 TO CLOSE' means action=close, contracts=2

Return ONLY a valid JSON array. Example:
[
  {
    "symbol": "NOW",
    "action": "open",
    "contracts": 2,
    "strike": 85,
    "expiry": "2026-04-25",
    "optionType": "put",
    "premium": 0.27,
    "broker": "schwab"
  }
]`;

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

// Accept either a full data URL (preferred — preserves mime) or a raw base64
// string (legacy — we assume PNG). Minimax rejects mime/bytes mismatches
// with 400 so the mime type must be truthful. Returns { dataUrl, mime, rawLen }
// for logging without leaking the image data itself.
function normalizeImage(input: string): { dataUrl: string; mime: string; rawLen: number } {
  const match = input.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
  if (match) {
    return { dataUrl: input, mime: match[1], rawLen: match[2].length };
  }
  return {
    dataUrl: `data:image/png;base64,${input}`,
    mime: "image/png",
    rawLen: input.length,
  };
}

export async function POST(req: NextRequest) {
  console.log(`[parse-screenshot] MINIMAX_API_KEY present: ${!!process.env.MINIMAX_API_KEY}`);
  if (!MINIMAX_KEY) {
    return NextResponse.json(
      { error: "MINIMAX_API_KEY is not configured on the server" },
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
  if (!rawImage) return NextResponse.json({ error: "Missing image" }, { status: 400 });

  const { dataUrl, mime, rawLen } = normalizeImage(rawImage);
  console.log(
    `[parse-screenshot] broker=${broker} mime=${mime} base64_bytes=${rawLen}`,
  );

  const buildBody = (model: string) => ({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
    max_tokens: 2000,
  });

  // Walk (model × endpoint) until one succeeds. On 401 we bail early —
  // that's an auth problem no permutation will fix. On 400/403/404/429 we
  // log and try the next combo. Network errors just get logged and we
  // keep going to the next endpoint.
  let res: Response | null = null;
  const failures: string[] = [];
  try {
    outer: for (const model of MINIMAX_MODELS) {
      for (const endpoint of MINIMAX_ENDPOINTS) {
        console.log(`[parse-screenshot] trying model=${model} endpoint=${endpoint}`);
        let attempt: Response;
        try {
          attempt = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${MINIMAX_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(buildBody(model)),
            cache: "no-store",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`${model}@${endpoint} network: ${msg}`);
          console.warn(`[parse-screenshot] network error ${model}@${endpoint}: ${msg}`);
          continue;
        }
        if (attempt.ok) {
          console.log(`[parse-screenshot] ok model=${model} endpoint=${endpoint}`);
          res = attempt;
          break outer;
        }
        const errText = await attempt.text();
        console.error(`Minimax error: ${attempt.status} ${errText}`);
        failures.push(
          `${model}@${endpoint} => ${attempt.status}: ${errText.slice(0, 200)}`,
        );
        if (attempt.status === 401) {
          return NextResponse.json(
            { error: `Minimax auth failed (401). Check MINIMAX_API_KEY. ${errText.slice(0, 300)}` },
            { status: 502 },
          );
        }
      }
    }

    if (!res) {
      return NextResponse.json(
        {
          error: `All Minimax attempts failed. ${failures.join(" | ").slice(0, 800)}`,
        },
        { status: 502 },
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return NextResponse.json({ error: "Empty response from Minimax" }, { status: 502 });
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

    console.log(
      `[parse-screenshot] broker=${broker} raw=${parsed.length} accepted=${trades.length}`,
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
