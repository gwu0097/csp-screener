import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // VLM calls can be slow

const MINIMAX_URL = "https://api.minimaxi.chat/v1/chat/completions";
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

// The model sometimes wraps the array in ```json fences or adds a leading
// "Here is the JSON:" line. Strip those before parsing.
function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in model output");
  }
  return JSON.parse(raw.slice(start, end + 1));
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

export async function POST(req: NextRequest) {
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

  const image = (body.image ?? "").replace(/^data:image\/[^;]+;base64,/, "");
  const broker = (body.broker ?? "schwab").toLowerCase();
  if (!image) return NextResponse.json({ error: "Missing image" }, { status: 400 });

  try {
    const res = await fetch(MINIMAX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MINIMAX_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-VL-01",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
        max_tokens: 1000,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[parse-screenshot] minimax ${res.status}: ${text.slice(0, 300)}`);
      return NextResponse.json(
        { error: `Minimax HTTP ${res.status}` },
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

    let parsed: unknown;
    try {
      parsed = extractJsonArray(content);
    } catch (e) {
      console.error(`[parse-screenshot] parse failed: ${e instanceof Error ? e.message : e}`);
      console.error(`[parse-screenshot] raw content: ${content.slice(0, 500)}`);
      return NextResponse.json({ error: "Could not parse model output as JSON" }, { status: 502 });
    }
    if (!Array.isArray(parsed)) {
      return NextResponse.json({ error: "Model did not return a JSON array" }, { status: 502 });
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
