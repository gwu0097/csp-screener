import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // VLM calls can be slow

// Screenshot parsing is powered by Google Gemini vision. MINIMAX_API_KEY is
// retained in the env but intentionally unused here. Auth goes via the
// x-goog-api-key header (not a query param) so the key never lands in URL
// logs or referrer headers.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";

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
  // Actual date the trade was placed (from the ToS "Time Placed" column).
  // Optional — if the model can't recover it, downstream falls back to today.
  timePlaced?: string; // YYYY-MM-DD
};

// Stock trades are a distinct shape — no strike / expiry / optionType, and
// action is 'buy' or 'sell' rather than 'open' / 'close'. Used by the
// swing trading flow.
export type ParsedStockTrade = {
  symbol: string;
  action: "buy" | "sell";
  shares: number;
  price: number;
  date: string; // YYYY-MM-DD
  broker: string;
};

const PROMPT_SCHWAB = `This is a screenshot of a ThinkorSwim (ThinkOrSwim) brokerage order history table. The table has colored rows (red for SELL/open, green for BUY/close).

Column headers are: Time Placed, Spread, Side, QtyPos Effect, Symbol, Exp, StrikeType, Price, TIF, Status

Extract every filled options trade row. Ignore stock trades (StrikeType 'STOCK' or 'ETF') AND ignore rows where Status column says CANCELED or EXPIRED. Only include rows with Status exactly FILLED.

If Status = FILLED and the row is an option (not STOCK/ETF), you must include it. Count your FILLED rows before finalizing — do not skip any.

For each options row:
- action: if Side=SELL and QtyPos Effect contains 'TO OPEN' → 'open'
         if Side=BUY and QtyPos Effect contains 'TO CLOSE' → 'close'
- contracts: the number before 'TO OPEN' or 'TO CLOSE' (ignore the +/- sign)
- symbol: the ticker in the Symbol column (e.g. NOW, GE, TSLA)
- strike: the number before PUT or CALL in StrikeType column. Strike prices are always 3-4 digits before the decimal for stocks trading above $100. If you see a strike like 47.5 or 47.50 for a stock trading above $100, it is likely 347.5 or 347.50 — re-read the full strike price carefully from the StrikeType column.
- optionType: 'put' or 'call' from StrikeType column
- expiry: the Exp column uses 'D MMM YY' or 'DD MMM YY' format — the number BEFORE the month is the DAY OF MONTH, the two-digit number AFTER the month is the YEAR (add 2000 to get the four-digit year). Examples: '1 MAY 26' = 2026-05-01 (May 1, 2026, NOT May 26); '26 MAY 26' = 2026-05-26 (May 26, 2026); '24 APR 26' = 2026-04-24. Single-digit days (1, 2, …, 9) appear without a leading zero — do not confuse them with a year suffix. Return the result in YYYY-MM-DD format.
- premium: the Price column value
- timePlaced: YYYY-MM-DD from the Time Placed column (first column). Drop the time-of-day portion — date only.

Return ONLY a JSON array, no explanation, no markdown.

Extract EVERY row in the table. Do not stop early. There may be 10-30 rows. Return all of them.

The Price column shows values like '.60 LMT' or '7.15 LMT'. The premium is the numeric value only — strip the ' LMT' / ' MKT' suffix and return the result as a JSON number (not a string). '.60 LMT' becomes 0.60. Read the exact digits — do not substitute, round, or guess.`;

const currentYear = new Date().getUTCFullYear();

// Robinhood ships two screenshot shapes for options. Format A (Position
// Detail cards) and Format B (Recent Activity transaction list). The
// prompt asks the model to identify which one it's looking at and emit
// the same ParsedTrade[] schema either way; downstream bulk-create
// routes Sell→open / Buy→close transparently.
const PROMPT_ROBINHOOD = `This is a Robinhood options screenshot. First decide which format it shows, then parse accordingly.

FORMAT A — Position Detail cards.
  Identifying fields visible on the card: "Market value", "Average credit", "Contracts", "Date sold", and "{SYMBOL} breakeven price". Each card represents ONE open short options position.

  Each card shows fields like:
  - Market value (e.g. "-$10.00")
  - Current price (e.g. "$0.01") — current option price
  - Current {SYMBOL} price (e.g. "$81.19") — current stock price
  - Expiration date (e.g. "4/24")
  - Average credit (e.g. "$0.17") — premium received when the position was sold
  - {SYMBOL} breakeven price (e.g. "$53.83")
  - Contracts (e.g. "-10") — negative because short; take the absolute value
  - Date sold (e.g. "4/23") — the date the short was opened

  Emit one object per card:
  - symbol: the ticker. It appears inside "Current {SYMBOL} price" and "{SYMBOL} breakeven price" labels. Example: "Current INTC price" → "INTC".
  - action: always "open".
  - contracts: absolute value of the Contracts field ("-10" → 10).
  - premium: numeric value of "Average credit", strip "$" ("$0.17" → 0.17).
  - expiry: "Expiration date" → YYYY-MM-DD; if the year is missing (e.g. "4/24"), use ${currentYear}. So "4/24" → "${currentYear}-04-24".
  - strike: breakeven_price + average_credit, rounded to the nearest $0.50 increment (standard option strike granularity). Examples: breakeven=53.83 + credit=0.17 → 54.00; breakeven=347.13 + credit=0.37 → 347.50.
  - optionType: default "put" for a CSP screening context. Use "call" only if the card explicitly says "Call".
  - timePlaced: "Date sold" → YYYY-MM-DD, same year-inference as expiry.
  - broker: "robinhood".

FORMAT B — Recent Activity list.
  Identifying fields: a vertical list of rows that start with "Buy" or "Sell" followed by a contract description, with an "Individual · Xm" subtitle. Each row's right-side amount is either a dollar value (filled) or the literal text "Canceled".

  Example rows (the layout shows the title on the left and the amount on the right; the second line is the subtitle plus the per-contract detail):

    Buy SPOT $410 Put 5/1               $212.00
    Individual · 5m              1 contract at $2.12

    Buy SPOT $410 Put 5/1               Canceled
    Individual · 6m

    Sell ETSY $52 Put 5/1               $169.00
    Individual · 7m              5 contracts at $0.338

  SKIP any row whose right-side amount column reads "Canceled" — do not emit it.

  For every non-canceled row, emit one object:
  - symbol: the ticker right after "Buy"/"Sell" ("SPOT", "ETSY").
  - action: "open" if the row starts with "Sell" (selling to open a short); "close" if it starts with "Buy" (buying to close).
  - contracts: integer from "X contract(s) at $Y" ("5 contracts at $0.338" → 5).
  - premium: per-contract value from "at $Y" ("$2.12" → 2.12, "$0.338" → 0.338). Do NOT use the row total.
  - strike: numeric after "$" in the description ("$410 Put" → 410, "$52 Put" → 52).
  - optionType: "put" if "Put" appears in the description, "call" if "Call" appears.
  - expiry: M/D appearing after the option type → YYYY-MM-DD. If the year is missing (e.g. "5/1"), use ${currentYear}. So "5/1" → "${currentYear}-05-01".
  - timePlaced: omit if no clear date is shown for the row (the "Xm" relative timestamp is not a date).
  - broker: "robinhood".

Return ONLY a JSON array (no explanation, no markdown). For Format A, one object per card. For Format B, one object per non-canceled row. If no parseable rows are found, return [].`;

// Stock-trade prompts. These target STOCK fills, not options — used by the
// swing trading import flow. The shape is intentionally narrower so
// downstream code doesn't have to guard against missing option fields.
const PROMPT_STOCK_SCHWAB = `Extract all FILLED stock trades from this ThinkorSwim / Schwab order history screenshot.

Column headers are: Time Placed, Spread, Side, QtyPos Effect, Symbol, Exp, StrikeType, Price, TIF, Status.

For each FILLED stock row (StrikeType = 'STOCK' or 'ETF', not options):
  symbol: the ticker (e.g. AMD, HOOD, CRM)
  action: 'buy' if Side=BUY, 'sell' if Side=SELL
  shares: the absolute number before 'TO OPEN' / 'TO CLOSE' (or the Qty column)
  price: the numeric value in the Price column — strip ' LMT' / ' MKT' suffix. '.60 LMT' becomes 0.60.
  date: YYYY-MM-DD from the Time Placed column (date only, drop the time)

Ignore: options rows (any row with a strike price or expiry), CANCELED orders, WORKING orders.
Only include rows with Status exactly FILLED and StrikeType STOCK/ETF.

Return ONLY a JSON array, no explanation, no markdown:
[{"symbol": "AMD", "action": "buy", "shares": 100, "price": 175.40, "date": "2026-04-22"}]

Extract EVERY stock row. Do not stop early.`;

const PROMPT_STOCK_ROBINHOOD = `Extract the stock position(s) from this Robinhood position card screenshot.

Each card shows:
- 'Current {SYMBOL} price' label — the ticker appears here
- 'Date bought' or 'Date sold' — the trade date
- 'Shares' — position size (may be negative for short sells; take absolute value)
- 'Average cost' (for buys) or 'Average sell price' (for sells) — the per-share price

For each card:
  symbol: from the 'Current {SYMBOL} price' label (e.g. "Current AMD price" → "AMD")
  action: 'buy' if the card shows 'Date bought', 'sell' if it shows 'Date sold'
  shares: absolute value of the Shares field (e.g. "-10" → 10)
  price: 'Average cost' for buys, 'Average sell price' for sells. Strip '$' prefix.
  date: 'Date bought' or 'Date sold', converted to YYYY-MM-DD. If year is missing (e.g. "4/23"), use current year ${currentYear}.

Return ONLY a JSON array, no explanation, no markdown:
[{"symbol": "AMD", "action": "buy", "shares": 100, "price": 175.40, "date": "${currentYear}-04-22"}]

Include every visible card as a separate entry.`;

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

// Accept "4/24" / "04/24" / "4/24/26" / "4/24/2026" as well as strict
// YYYY-MM-DD. Missing year falls back to the current year. Returns
// "" if nothing sensible can be derived. Robinhood emits "4/24"-style
// dates; Schwab emits full dates. Duplicated in test/test-robinhood-parser.ts.
function normalizeExpiry(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const mdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    let year = new Date().getUTCFullYear();
    if (mdy[3]) {
      const y = Number(mdy[3]);
      year = y < 100 ? 2000 + y : y;
    }
    return `${year}-${mm}-${dd}`;
  }
  return "";
}

// Nearest $0.50 increment — standard option strike granularity.
function roundStrikeToHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

function coerceTrade(raw: unknown, fallbackBroker: string): ParsedTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase().trim() : "";
  const action = r.action === "open" || r.action === "close" ? r.action : null;
  // Accept both "put"/"call" and "PUT"/"CALL" — Robinhood prompt may
  // keep the original casing even when we ask for lowercase.
  const rawOptionType = typeof r.optionType === "string" ? r.optionType.toLowerCase() : "";
  const optionType = rawOptionType === "put" || rawOptionType === "call" ? rawOptionType : null;
  // Robinhood emits negative contracts for shorts; take the abs value
  // defensively even if the prompt already stripped the sign.
  const contracts = Math.abs(Number(r.contracts));
  const broker =
    typeof r.broker === "string" && r.broker.trim() ? r.broker.toLowerCase() : fallbackBroker;
  // For Robinhood, round the calculated strike to nearest $0.50 even if
  // the model returned an unrounded raw value (e.g. 53.83 + 0.17 = 54.00
  // always, but bigger tickers can land on 0.47 etc.).
  let strike = Number(r.strike);
  if (broker === "robinhood" && Number.isFinite(strike)) {
    strike = roundStrikeToHalf(strike);
  }
  const premium = Number(r.premium);
  const expiry =
    typeof r.expiry === "string" ? normalizeExpiry(r.expiry) : "";
  const rawTime = typeof r.timePlaced === "string" ? r.timePlaced.trim() : "";
  const timePlaced = rawTime ? normalizeExpiry(rawTime) : "";
  const timePlacedOut = /^\d{4}-\d{2}-\d{2}$/.test(timePlaced) ? timePlaced : undefined;
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
    timePlaced: timePlacedOut,
  };
}

function coerceStockTrade(raw: unknown, fallbackBroker: string): ParsedStockTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase().trim() : "";
  const rawAction = typeof r.action === "string" ? r.action.toLowerCase() : "";
  const action = rawAction === "buy" || rawAction === "sell" ? rawAction : null;
  const shares = Math.abs(Number(r.shares));
  const price = Number(r.price);
  const broker =
    typeof r.broker === "string" && r.broker.trim()
      ? r.broker.toLowerCase()
      : fallbackBroker;
  const date = typeof r.date === "string" ? normalizeExpiry(r.date) : "";
  if (!symbol || !action) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return { symbol, action, shares, price, date, broker };
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

  let body: { image?: string; broker?: string; tradeType?: string };
  try {
    body = (await req.json()) as { image?: string; broker?: string; tradeType?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawImage = body.image ?? "";
  const broker = (body.broker ?? "schwab").toLowerCase();
  const tradeType = body.tradeType === "stock" ? "stock" : "options";
  // Distinct from base64 length: the raw JSON field as received. If this
  // is 0/undefined, the client isn't actually sending anything.
  console.log(`[parse-screenshot] image bytes: ${rawImage ? rawImage.length : 0}`);
  if (!rawImage) return NextResponse.json({ error: "Missing image" }, { status: 400 });

  const { mime, data, rawLen } = normalizeImage(rawImage);
  console.log(
    `[parse-screenshot] broker=${broker} mime=${mime} base64_bytes=${rawLen}`,
  );

  // Select prompt by (tradeType, broker). Stock mode uses narrower
  // prompts that extract only symbol/shares/price/date. Options mode
  // uses the existing ToS / Robinhood option prompts.
  let prompt: string;
  let promptName: string;
  if (tradeType === "stock") {
    prompt = broker === "robinhood" ? PROMPT_STOCK_ROBINHOOD : PROMPT_STOCK_SCHWAB;
    promptName = broker === "robinhood" ? "stock-robinhood" : "stock-schwab";
  } else {
    prompt = broker === "robinhood" ? PROMPT_ROBINHOOD : PROMPT_SCHWAB;
    promptName = broker === "robinhood" ? "robinhood" : "schwab";
  }
  console.log(`[parse-screenshot] gemini url: ${GEMINI_URL}  prompt=${promptName}`);
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mime, data } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          // 2.5 Flash is a thinking model; thinking tokens count against
          // maxOutputTokens. For this extraction task, reasoning burns
          // budget without helping quality, so we disable it.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[parse-screenshot] gemini network error: ${msg}`);
    return NextResponse.json({ error: `Gemini network error: ${msg}` }, { status: 502 });
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini error: ${res.status} ${errText}`);
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { error: `Gemini auth failed (${res.status}). Check GEMINI_API_KEY. ${errText.slice(0, 300)}` },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `Gemini HTTP ${res.status}: ${errText.slice(0, 500)}` },
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

    let trades: ParsedTrade[] | ParsedStockTrade[];
    if (tradeType === "stock") {
      trades = parsed
        .map((r) => coerceStockTrade(r, broker))
        .filter((t): t is ParsedStockTrade => t !== null);
    } else {
      trades = parsed
        .map((r) => coerceTrade(r, broker))
        .filter((t): t is ParsedTrade => t !== null);
    }

    // NB: model_trades is the array parsed from the model's response, not the
    // count of bytes received. If model_trades=0 we got a valid response
    // with no trades — check the logged raw content to see what the model
    // actually produced.
    console.log(
      `[parse-screenshot] broker=${broker} tradeType=${tradeType} model_trades=${parsed.length} accepted=${trades.length}`,
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
