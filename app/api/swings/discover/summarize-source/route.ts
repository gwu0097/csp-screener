import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";

export const dynamic = "force-dynamic";
// Fetch + Perplexity round-trip — usually 2-6s. Keep margin for slow
// outbound fetches behind paywalls / rate limits.
export const maxDuration = 30;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Coerce a possibly schemeless URL ("stocktitan.net/news/...") into a
// fully qualified one. Perplexity citations occasionally drop the
// scheme.
function ensureHttp(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url.replace(/^\/+/, "")}`;
}

// Pull readable text out of a raw HTML string. Strips <script> / <style>
// blocks, all remaining tags, decodes the most common entities, collapses
// whitespace. Not parsing-grade — but enough body to feed a 2-3 sentence
// LLM summary against.
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchArticle(
  url: string,
  timeoutMs = 10000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Some sites return abridged content (or 403) for empty UAs.
        "User-Agent":
          "Mozilla/5.0 (compatible; CSPScreenerSwingDiscover/1.0; +https://example.com)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[summarize-source] ${url}: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    return extractText(html).slice(0, 3000);
  } catch (e) {
    console.warn(
      `[summarize-source] ${url}: fetch failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildPromptWithBody(symbol: string, body: string): string {
  return `Summarize this article in 2-3 sentences focused on what it says about ${symbol} specifically. If the article doesn't mention ${symbol} directly, summarize the main point relevant to a swing trader.

Article content:
${body}

Return only the summary, no preamble, no markdown.`;
}

// Fallback used when the local fetch fails (paywalled / blocked / 404):
// hand the URL to Perplexity and let its built-in browsing summarize.
function buildPromptFromUrl(symbol: string, url: string): string {
  return `Visit ${url} and summarize what it says about ${symbol} in 2-3 sentences. If the page doesn't mention ${symbol}, give the main takeaway relevant to a swing trader.

Return only the summary, no preamble, no markdown.`;
}

export async function POST(req: NextRequest) {
  let body: { url?: unknown; symbol?: unknown };
  try {
    body = (await req.json()) as { url?: unknown; symbol?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!rawUrl) return NextResponse.json({ error: "Missing url" }, { status: 400 });
  if (!symbol)
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });

  const url = ensureHttp(rawUrl);

  const article = await fetchArticle(url);
  const usingFallback = article === null || article.length < 100;
  const prompt = usingFallback
    ? buildPromptFromUrl(symbol, url)
    : buildPromptWithBody(symbol, article as string);

  const res = await askPerplexityRaw(prompt, {
    maxTokens: 250,
    label: `summarize:${symbol}:${domainOf(url)}`,
  });
  if (!res || !res.text.trim()) {
    return NextResponse.json(
      {
        url,
        domain: domainOf(url),
        summary: null,
        error: "Could not generate summary",
      },
      { status: 502 },
    );
  }
  // Trim the model's output. Perplexity sometimes prefixes with citation
  // numbers like "[1] " — strip them so the card body stays clean.
  const summary = res.text
    .trim()
    .replace(/^\[\d+\]\s*/g, "")
    .trim();

  return NextResponse.json({
    url,
    domain: domainOf(url),
    summary,
    source_fetched: !usingFallback,
  });
}
