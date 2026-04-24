// Perplexity news-context lookup for earnings setups. Pulls the last
// ~30 days of coverage and returns a structured summary + overhang flag
// + grade penalty that feeds the Layer-3 "regime" grade in the screener.

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY ?? "";
const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export type PerplexitySentiment = "positive" | "negative" | "neutral";

export type PerplexityNewsResult = {
  summary: string;
  sentiment: PerplexitySentiment;
  hasActiveOverhang: boolean;
  overhangDescription: string | null;
  sources: string[];
  gradePenalty: number; // 0, -5, or -15
};

// Default returned when Perplexity is unavailable or the response can't
// be parsed. Neutral + no penalty so the setup isn't unfairly punished
// by an infra issue.
const FALLBACK: PerplexityNewsResult = {
  summary: "Could not fetch news context",
  sentiment: "neutral",
  hasActiveOverhang: false,
  overhangDescription: null,
  sources: [],
  gradePenalty: 0,
};

function buildPrompt(symbol: string, companyName: string): string {
  return `For ${companyName} (${symbol}), reporting earnings tonight or tomorrow morning, search for news from the last 30 days.

Identify if ANY of these active risks exist:
1. Government regulatory action or investigation
2. Major legislative change directly impacting revenue
3. CEO or CFO sudden departure (last 90 days)
4. DOJ, SEC, or FTC action opened
5. Major customer loss or contract cancellation
6. Bankruptcy or liquidity risk
7. Major product recall or safety issue

Also assess overall news sentiment for this earnings.

Respond in this exact JSON format only:
{
  "summary": "2-3 sentence news summary",
  "sentiment": "positive|negative|neutral",
  "hasActiveOverhang": true|false,
  "overhangDescription": "description or null",
  "gradePenalty": 0
}

Set gradePenalty:
- 0 if sentiment neutral/positive and no overhang
- -5 if sentiment negative but no major overhang
- -15 if hasActiveOverhang is true

Return ONLY valid JSON.`;
}

// Strip ```json / ``` fences the model sometimes wraps responses in.
function unwrapJson(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function coerceSentiment(v: unknown): PerplexitySentiment {
  return v === "positive" || v === "negative" ? v : "neutral";
}

// Generic single-turn Perplexity call. Returns the raw message content
// as a string plus any citations. Callers parse the body themselves —
// this keeps the helper shape-agnostic so a new feature can reuse it
// without hacking in a bespoke parser. Unlike getEarningsNewsContext
// there is no typed fallback: the caller decides what to do on failure.
export async function askPerplexityRaw(
  prompt: string,
  opts?: { maxTokens?: number; label?: string },
): Promise<{ text: string; citations: string[] } | null> {
  const label = opts?.label ?? "pplx";
  if (!PERPLEXITY_API_KEY) {
    console.warn(`[perplexity] ${label}: PERPLEXITY_API_KEY not set`);
    return null;
  }
  const body = JSON.stringify({
    model: "sonar",
    messages: [{ role: "user", content: prompt }],
    max_tokens: opts?.maxTokens ?? 1500,
    temperature: 0,
  });
  let res: Response;
  try {
    res = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    console.warn(
      `[perplexity] ${label} network error: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[perplexity] ${label} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return null;
  }
  let json: {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }
  const text = json.choices?.[0]?.message?.content ?? "";
  const citations = Array.isArray(json.citations)
    ? json.citations.filter((x): x is string => typeof x === "string")
    : [];
  return { text, citations };
}

export async function getEarningsNewsContext(
  symbol: string,
  companyName: string,
): Promise<PerplexityNewsResult> {
  if (!PERPLEXITY_API_KEY) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set — returning fallback");
    return FALLBACK;
  }

  const body = JSON.stringify({
    model: "sonar",
    messages: [{ role: "user", content: buildPrompt(symbol, companyName) }],
    max_tokens: 500,
    temperature: 0,
  });

  let res: Response;
  try {
    res = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    console.warn(
      `[perplexity] network error for ${symbol}: ${e instanceof Error ? e.message : e}`,
    );
    return FALLBACK;
  }

  if (!res.ok) {
    const errText = await res.text();
    console.warn(
      `[perplexity] ${symbol} HTTP ${res.status}: ${errText.slice(0, 300)}`,
    );
    return FALLBACK;
  }

  let json: { choices?: Array<{ message?: { content?: string } }>; citations?: string[] };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return FALLBACK;
  }

  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) return FALLBACK;

  try {
    const parsed = JSON.parse(unwrapJson(text)) as {
      summary?: unknown;
      sentiment?: unknown;
      hasActiveOverhang?: unknown;
      overhangDescription?: unknown;
      gradePenalty?: unknown;
    };
    const hasOverhang = parsed.hasActiveOverhang === true;
    const rawPenalty = Number(parsed.gradePenalty);
    // Clamp to the documented values. Keeps the scoring math predictable
    // if the model ever emits something like -7.
    let penalty = Number.isFinite(rawPenalty) ? rawPenalty : 0;
    if (![0, -5, -15].includes(penalty)) {
      if (hasOverhang) penalty = -15;
      else if (penalty < 0) penalty = -5;
      else penalty = 0;
    }
    return {
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : "No news summary available",
      sentiment: coerceSentiment(parsed.sentiment),
      hasActiveOverhang: hasOverhang,
      overhangDescription:
        typeof parsed.overhangDescription === "string" && parsed.overhangDescription !== "null"
          ? parsed.overhangDescription
          : null,
      sources: Array.isArray(json.citations) ? json.citations.filter((x): x is string => typeof x === "string") : [],
      gradePenalty: penalty,
    };
  } catch (e) {
    console.warn(
      `[perplexity] could not parse ${symbol} response: ${e instanceof Error ? e.message : e}`,
    );
    console.warn(`[perplexity] raw content: ${text.slice(0, 400)}`);
    return FALLBACK;
  }
}
