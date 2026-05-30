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
  // Group key set by the parser when a row belongs to a multi-leg
  // spread (e.g. CALENDAR roll). Two trades sharing the same value
  // are the two legs of one order — the modal renders a "ROLL" badge
  // to show the link. Not persisted to DB; preview-only metadata.
  spread_group?: string;
  // Actual moment the trade was placed (from the ToS "Time Placed" column).
  // Either "YYYY-MM-DD" (date-only, when the source UI shows no time) or
  // "YYYY-MM-DDTHH:MM:SS" (preferred — lets downstream toPstDate() do an
  // exact source-tz → PT conversion instead of guessing an anchor hour).
  // Optional — if the model can't recover it, downstream falls back to today.
  timePlaced?: string;
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

STATUS FILTER (do this first, before extracting any data):
Only extract rows where the Status column shows exactly 'FILLED'.
Skip every row whose Status is 'CANCELED', 'EXPIRED', 'REJECTED', or anything other than FILLED.
For each FILLED row you MUST include it — both option fills AND stock fills. Count your FILLED rows before finalizing — do not skip any.

OPTION vs STOCK CLASSIFICATION (decide per row before extracting fields):
A row is a STOCK trade when ANY of these indicators are present:
  • StrikeType column reads exactly 'STOCK' or 'ETF'
  • No expiry date in the Exp column (or the Exp cell is empty / a dash)
  • No 'PUT' / 'CALL' suffix in the StrikeType column
  • Symbol appears alone (e.g. 'NET', 'AMD') with no '100 (Weeklys)' suffix or expiry beside it
  • Price column shows a stock-sized number ($25–$1000 range), not an option premium ($0.05–$25 range)

A row is an OPTION trade when ALL of these are visible together:
  • Exp column shows a date like '8 MAY 26', '15 MAY 26'
  • StrikeType shows '120 PUT' / '347.50 CALL' (a strike followed by PUT / CALL)
  • Optionally with '100 (Weeklys)', '(Weekly)', '(Mini)' or similar contract suffix
  • Price column shows a small premium ($0.05–$25)

When the indicators conflict, prefer the OPTION interpretation only if BOTH a numeric strike AND a PUT/CALL designation are visible. Otherwise default to STOCK.

OUTPUT FORMAT:
Return one mixed JSON array. Each element is either an OPTION fill or a STOCK fill — discriminate with a top-level "trade_type" field. Schemas:

OPTION:  { "trade_type": "option", "action": "open"|"close", "contracts": N, "symbol": str, "strike": N, "expiry": "YYYY-MM-DD", "optionType": "put"|"call", "premium": N, "timePlaced": "YYYY-MM-DDTHH:MM:SS", "spread_group": str (optional) }
STOCK:   { "trade_type": "stock",  "action": "buy"|"sell",    "shares":    N, "symbol": str, "price":  N, "date":   "YYYY-MM-DD" }

spread_group: include ONLY for multi-leg spread rows (CALENDAR / DIAGONAL / VERTICAL / etc.). Use a short string label like "ROLL_1", "ROLL_2", "VERT_1" — both legs of the same order must share the SAME label so downstream can link them. For non-spread SINGLE rows, omit the field.

If a row is unmistakably a stock fill, emit only the stock schema (no strike / expiry / optionType — leave those out entirely). If it's an option, emit only the option schema.

SPREAD HANDLING:
The 'Spread' column tells you the order type:
- 'SINGLE' = one option leg, one row → emit ONE trade.
- 'DIAGONAL', 'VERTICAL', 'CALENDAR', 'IRON_CONDOR', etc. = MULTI-LEG order. Schwab displays each leg on its own physical line, sharing the Time Placed / Spread / Status of the first leg. The Status (FILLED/etc.) applies to BOTH/ALL legs together.
For multi-leg orders:
  • Emit EACH leg as a SEPARATE trade in the output array (a DIAGONAL produces TWO trade entries, a VERTICAL with 2 legs produces TWO entries, etc.).
  • Each leg has its OWN Side, Qty (with sign), Symbol, Exp, StrikeType, Price — read each independently.
  • Per-leg action comes from THAT leg's text/sign (a DIAGONAL typically has one SELL TO OPEN leg and one BUY TO CLOSE leg; they emit as action='open' and action='close' respectively).
  • PRICE QUIRK: for multi-leg orders, one leg often shows 'CREDIT' / 'DEBIT' in the Price column (or 'NET CREDIT' / 'NET DEBIT') instead of a numeric LMT price — that's the SPREAD'S net credit/debit, not the individual leg's premium. The other leg shows the real numeric LMT price. For the leg that shows CREDIT/DEBIT (no per-leg numeric price), set premium = 0 in your output. The numeric-price leg gets its actual price.

Worked example (DIAGONAL row spans two lines, one Status applies to both):
  5/8/26 12:54:27  DIAGONAL  SELL  -3 TO OPEN   ANET  15 MAY 26 (Weeklys)  150 PUT  4.75 LMT  DAY  FILLED
                              BUY   +3 TO CLOSE  ANET   8 MAY 26 (Weeklys)  146 PUT  CREDIT
Emits TWO trades (note the shared spread_group):
  { action: 'open',  symbol: 'ANET', strike: 150, expiry: '2026-05-15', optionType: 'put', contracts: 3, premium: 4.75, timePlaced: '2026-05-08', spread_group: 'DIAG_1' }
  { action: 'close', symbol: 'ANET', strike: 146, expiry: '2026-05-08', optionType: 'put', contracts: 3, premium: 0,    timePlaced: '2026-05-08', spread_group: 'DIAG_1' }
(The CREDIT leg gets premium=0 because the per-leg price isn't shown — the user will edit the close price manually.)

CALENDAR (condensed display variant — different from the per-row layout above):
Schwab sometimes shows a CALENDAR roll as ONE header row plus a "TRADE FILLS" detail block, instead of two physical rows. The header looks like:
  CALENDAR  NET  100 (Weeklys)
            22 MAY 26 / 15 MAY 26 (0)  210 P
And the TRADE FILLS detail block beneath it shows two per-leg lines:
  -2  @ 13.88     (the SHORT/far leg: SELL TO OPEN at the FIRST expiry, here 22 MAY 26)
  +2  @ 11.28     (the LONG/near leg: BUY  TO CLOSE at the SECOND expiry, here 15 MAY 26)
  Net: 2.60 CREDIT
For this format:
  • The two expiries are slash-separated in the header — read both. The FIRST date is the FAR leg, the SECOND is the NEAR leg (Schwab orders them far/near).
  • Strike and option type come from the trailing "{STRIKE} P" / "{STRIKE} C" in the header. "P" → put, "C" → call.
  • Quantity sign in the TRADE FILLS rows determines the action: -N → action='open' (the short leg at the far expiry); +N → action='close' (the long leg at the near expiry — which closes an existing CSP at the near expiry).
  • premium for each leg is the "@ X.XX" value on that fill row (NOT the spread net credit).
  • timePlaced for BOTH legs comes from the order's fill timestamp. The Order Detail screen does NOT show a Time Placed column — instead, look for the timestamp in either of two places:
        – the order status header: "FILLED 5/15/26, 10:43 PM" (top of the panel)
        – or the timestamp on the TRADE FILLS section: "5/15/26, 10:43 PM"
    Both legs of a CALENDAR get the SAME timePlaced. Convert 12-hour AM/PM to 24-hour:
        "5/15/26, 10:43 PM" → "2026-05-15T22:43:00"
        "5/15/26,  9:34 AM" → "2026-05-15T09:34:00"
    If no seconds are visible, use "00". NEVER leave timePlaced empty for a CALENDAR row — the fill timestamp is always shown somewhere on this screen.
  • Both emitted trades share the SAME spread_group label (e.g. "ROLL_1") so the UI can render them as a linked pair. Increment the suffix ("ROLL_2", "ROLL_3", …) for additional calendar rolls in the same screenshot.
Emits TWO trades for the NET example:
  { action: 'open',  symbol: 'NET', strike: 210, expiry: '2026-05-22', optionType: 'put', contracts: 2, premium: 13.88, timePlaced: '2026-05-15T22:43:00', spread_group: 'ROLL_1' }
  { action: 'close', symbol: 'NET', strike: 210, expiry: '2026-05-15', optionType: 'put', contracts: 2, premium: 11.28, timePlaced: '2026-05-15T22:43:00', spread_group: 'ROLL_1' }

For each options row:
- action: determine whether this row OPENS or CLOSES a position. Rule cascade — apply in order, first match wins:
    1. If the row text explicitly contains 'TO OPEN'  → action = 'open'
    2. If the row text explicitly contains 'TO CLOSE' → action = 'close'
    3. Else look at the Side/Action column AND the quantity sign:
         - 'SOLD' / 'SELL' / negative quantity (e.g. -5, -2)   → action = 'open'
           (Schwab marks a sell-to-open short put with SOLD and a negative quantity; this is the typical CSP entry.)
         - 'BOT' / 'BUY'  / positive quantity (e.g. +12, +6)   → action = 'close'
           (Closing a short put = buy-to-close, marked BOT with a positive quantity.)
    The +/- sign on the quantity is the most reliable signal — negative = open, positive = close.
- contracts: the ABSOLUTE VALUE of the quantity (always a positive integer). Strip any leading sign and any 'TO OPEN' / 'TO CLOSE' suffix. Examples: '-5 TO OPEN' → 5, '+12 TO CLOSE' → 12, '-2' → 2, '+6' → 6.
- symbol: the ticker in the Symbol column (e.g. NOW, GE, TSLA)
- strike: the number before PUT or CALL in StrikeType column. Strike prices are always 3-4 digits before the decimal for stocks trading above $100. If you see a strike like 47.5 or 47.50 for a stock trading above $100, it is likely 347.5 or 347.50 — re-read the full strike price carefully from the StrikeType column.
- optionType: 'put' or 'call' from StrikeType column
- expiry: the Exp column uses 'D MMM YY' or 'DD MMM YY' format. Read it as DAY-MONTH-YEAR strictly:
    * The token BEFORE the month is the DAY (a 1-2 digit number, range 1-31).
    * The MONTH is the 3-letter abbreviation (JAN, FEB, MAR, APR, MAY, JUN, JUL, AUG, SEP, OCT, NOV, DEC).
    * The token AFTER the month is the YEAR. The year is always '26' (= 2026) on a recent Schwab screenshot. Add 2000 to get the four-digit year.
    NEVER confuse the year suffix '26' with the day number. The position before the month is ALWAYS the day; the position after the month is ALWAYS the year.
    Single-digit days (1, 2, 3, 4, 5, 6, 7, 8, 9) appear WITHOUT a leading zero. These are the ambiguous cases the model most often gets wrong:
      '1 MAY 26'  → 2026-05-01  (May 1 2026 — NOT May 26 2026)
      '8 MAY 26'  → 2026-05-08  (May 8 2026 — NOT May 26 2026)
      '9 JUN 26'  → 2026-06-09  (June 9 2026 — NOT June 26 2026)
      '24 APR 26' → 2026-04-24  (April 24 2026, correct)
      '26 MAY 26' → 2026-05-26  (May 26 2026, correct — both day and year happen to be 26)
    Return the result in strict YYYY-MM-DD format.
- premium: the Price column value
- timePlaced: full datetime as "YYYY-MM-DDTHH:MM:SS" (24-hour, seconds optional → use "00" if not shown). The Time Placed column shows date+time like "5/14/26, 9:34:12 PM" or "5/14/26 21:34:12" — combine them. Examples:
    "5/14/26, 9:34:12 PM" → "2026-05-14T21:34:12"
    "5/14/26  21:34:12"   → "2026-05-14T21:34:12"
    "5/14/26  09:34"      → "2026-05-14T09:34:00"
  If the row only shows a date (no time at all), emit "YYYY-MM-DD" with no T-prefix — downstream will fall back to an anchor time. Never invent a time.

For each stock row:
- action: 'sell' if the Side column is 'SOLD' or 'SELL' (or the quantity is negative); 'buy' if the Side column is 'BOT' or 'BUY' (or the quantity is positive).
- shares: the ABSOLUTE VALUE of the quantity (positive integer). Stock fills are typically larger than option contract counts — 100, 250, 500, etc.
- symbol: the ticker in the Symbol column (e.g. NET, AMD, HOOD).
- price: the number in the Price column. Strip ' LMT' / ' MKT' / 'AVG' suffixes. Stock prices are typically in the $25–$1000 range. For a stock fill at '202.50 LMT' emit price=202.50.
- date: YYYY-MM-DD from the Time Placed column (date only).
- Do NOT emit strike, expiry, optionType, premium, or timePlaced for stock rows.

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
  date: full datetime as "YYYY-MM-DDTHH:MM:SS" (24-hour) from the Time Placed column. Combine the date and time-of-day cells. Example: "5/14/26, 9:34:12 PM" → "2026-05-14T21:34:12". If only a date is visible (no time), emit "YYYY-MM-DD" with no T-prefix.

Ignore: options rows (any row with a strike price or expiry), CANCELED orders, WORKING orders.
Only include rows with Status exactly FILLED and StrikeType STOCK/ETF.

Return ONLY a JSON array, no explanation, no markdown:
[{"symbol": "AMD", "action": "buy", "shares": 100, "price": 175.40, "date": "2026-04-22T14:31:08"}]

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

// timePlaced may arrive as "YYYY-MM-DDTHH:MM[:SS]" (preferred, full
// datetime — Schwab ToS "Time Placed" column) or as a date in either
// YYYY-MM-DD or M/D[/YY] form. Preserve the datetime form when present
// so toPstDate() can do an exact source-tz → PT conversion. Pad missing
// seconds with "00".
function normalizeTimePlaced(raw: string): string {
  const trimmed = raw.trim();
  const dt = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(trimmed);
  if (dt) {
    const sec = dt[3] ?? "00";
    return `${dt[1]}T${dt[2]}:${sec}`;
  }
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
  // The user-picked broker in the dropdown is authoritative — the model
  // may emit `broker: "schwab"` for the Schwab prompt and clobber a
  // `schwab2` (or future multi-account) selection. Trusting the request
  // wins keeps each Schwab account routed to its own grouping.
  const broker = fallbackBroker.toLowerCase();
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
  const timePlaced = rawTime ? normalizeTimePlaced(rawTime) : "";
  const timePlacedOut = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(timePlaced)
    ? timePlaced
    : undefined;
  // Preview-only metadata for multi-leg spreads. Validate as a short
  // alphanumeric label so an unexpected payload can't poison the UI.
  const rawGroup = typeof r.spread_group === "string" ? r.spread_group.trim() : "";
  const spread_group = /^[A-Za-z0-9_-]{1,32}$/.test(rawGroup) ? rawGroup : undefined;
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
    spread_group,
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
  // User-picked broker wins — see coerceTrade comment.
  const broker = fallbackBroker.toLowerCase();
  // Stock-trade dates may carry a datetime suffix (e.g. Schwab "Time
  // Placed") so downstream toPstDate() can do an exact source-tz → PT
  // conversion. Accept either form.
  const date = typeof r.date === "string" ? normalizeTimePlaced(r.date) : "";
  if (!symbol || !action) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(date)) return null;
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
    // 8000-char window so multi-trade screenshots don't get truncated.
    console.log(
      `[parse-screenshot] raw content (len=${content.length}): ${content.slice(0, 8000)}`,
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

    type Rejection = { symbol: string; reason: string };
    const rejections: Rejection[] = [];

    // Classify each raw item as option vs stock. The Schwab options
    // prompt now emits a mixed array discriminated by trade_type;
    // legacy stock-only prompts (Robinhood position cards, etc.)
    // emit pure stock items and skip trade_type entirely. Fall back
    // to field-shape detection so older prompt versions still work.
    const isStockItem = (raw: unknown): boolean => {
      if (!raw || typeof raw !== "object") return false;
      const r = raw as Record<string, unknown>;
      const tt =
        typeof r.trade_type === "string" ? r.trade_type.toLowerCase() : "";
      if (tt === "stock") return true;
      if (tt === "option") return false;
      // Shape inference: stock items carry shares/price; option items
      // carry strike/expiry/optionType. Missing all option fields
      // and having shares-or-price → treat as stock.
      const hasOptionShape =
        r.strike !== undefined || r.expiry !== undefined || r.optionType !== undefined;
      const hasStockShape = r.shares !== undefined || r.price !== undefined;
      if (!hasOptionShape && hasStockShape) return true;
      return false;
    };

    const optionItems: unknown[] = [];
    const stockItems: unknown[] = [];
    for (const item of parsed) {
      if (isStockItem(item)) stockItems.push(item);
      else optionItems.push(item);
    }

    let trades: ParsedTrade[];
    let stockTrades: ParsedStockTrade[];
    if (tradeType === "stock") {
      // Legacy stock-only request — keep returning trades[] for callers
      // that still rely on the prior shape.
      trades = [];
      stockTrades = parsed
        .map((r) => coerceStockTrade(r, broker))
        .filter((t): t is ParsedStockTrade => t !== null);
    } else {
      // Allow timePlaced up to 24h ahead of "now" so a user whose
      // local calendar already rolled over (HK / Tokyo at midnight
      // UTC = next day's morning local) doesn't get their imports
      // rejected as "future". The same +24h buffer also handles
      // the reverse case (server clock drift, daylight-saving
      // jitter) without needing to encode any specific timezone.
      const maxAllowedMs = Date.now() + 24 * 60 * 60 * 1000;
      const accepted: ParsedTrade[] = [];
      for (const r of optionItems) {
        const t = coerceTrade(r, broker);
        if (!t) continue; // structural reject (missing fields, bad strike/contracts, etc.)
        // Use just the date portion of timePlaced for the +24h future
        // guard — the guard is calendar-coarse and a datetime suffix
        // (e.g. "2026-05-14T21:34:00") would break the `T00:00:00Z`
        // concatenation.
        const placedMs = t.timePlaced
          ? new Date(`${t.timePlaced.slice(0, 10)}T00:00:00Z`).getTime()
          : null;
        if (placedMs !== null && placedMs > maxAllowedMs) {
          rejections.push({
            symbol: t.symbol,
            reason: `Trade rejected — date appears invalid (timePlaced: ${t.timePlaced} is more than 24h in the future). Please edit the date before confirming.`,
          });
          continue;
        }
        // Sanity check: you can't open or close a trade AFTER its
        // expiry. We do NOT reject simply because the expiry is in
        // the past — users routinely import historical trades after
        // the fact (catching up from travel, backfilling from old
        // screenshots, etc.). The only real failure mode is a
        // mis-parsed expiry that lands BEFORE the fill date.
        const placedDate = t.timePlaced ? t.timePlaced.slice(0, 10) : null;
        if (placedDate && placedDate > t.expiry) {
          rejections.push({
            symbol: t.symbol,
            reason: `Trade rejected — fill date ${placedDate} is after expiry ${t.expiry}. A trade can't be placed after the option expired.`,
          });
          continue;
        }
        accepted.push(t);
      }
      trades = accepted;
      stockTrades = stockItems
        .map((r) => coerceStockTrade(r, broker))
        .filter((t): t is ParsedStockTrade => t !== null);
    }

    // Per-trade log so we can compare what Gemini emitted vs what
    // the parser ended up with after normalization. Catches cases
    // where the raw response and the coerced result diverge.
    for (const t of trades) {
      console.log(
        `[parse-screenshot] coerced option: symbol=${t.symbol} action=${t.action} strike=${t.strike} expiry=${t.expiry} timePlaced=${t.timePlaced ?? "null"} contracts=${t.contracts} premium=${t.premium}`,
      );
    }
    for (const s of stockTrades) {
      console.log(
        `[parse-screenshot] coerced stock: symbol=${s.symbol} action=${s.action} shares=${s.shares} price=${s.price} date=${s.date}`,
      );
    }
    for (const r of rejections) {
      console.log(`[parse-screenshot] rejected: ${r.symbol} — ${r.reason}`);
    }

    // NB: model_trades is the array parsed from the model's response, not the
    // count of bytes received. If model_trades=0 we got a valid response
    // with no trades — check the logged raw content to see what the model
    // actually produced.
    console.log(
      `[parse-screenshot] broker=${broker} tradeType=${tradeType} model_trades=${parsed.length} option_accepted=${trades.length} stock_accepted=${stockTrades.length} rejected=${rejections.length}`,
    );
    return NextResponse.json({ trades, stockTrades, rejections });
  } catch (e) {
    console.error("[parse-screenshot] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Parse failed" },
      { status: 500 },
    );
  }
}
