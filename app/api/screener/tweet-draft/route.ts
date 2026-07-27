import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Drafts trade-disclosure posts from facts already computed and RANKED
// client-side (which supporting facts are strong enough to include,
// which single concern is the most material risk) — no re-fetch of
// chain/news/history/Trade-Decision-Context here, the client already
// pulled whatever it needed. The LLM's only job is voice and
// structure: turn a pre-selected strengths list + a single risk into
// a strengths -> risk -> why-anyway draft. Position size, contract
// count, premium, and dollar amounts are simply never included in
// what's sent, so there's nothing to leak even by accident — but live
// figures (POP, options flow ratios, delta) that the client marked as
// strong/risky ARE passed through and expected to appear verbatim.
export const maxDuration = 60;

type Fact = { id: string; text: string };

type Body = {
  symbol?: unknown;
  strike?: unknown;
  expiry?: unknown;
  earningsDate?: unknown;
  earningsTiming?: unknown;
  dte?: unknown;
  grade?: unknown;
  gradeIsPreview?: unknown;
  strengths?: unknown; // Fact[]
  risk?: unknown; // { id, text, isDissent, keyMetric? } | null
  convictionNote?: unknown; // string
  charLimit?: unknown;
};

const VALID_GRADES = new Set(["A", "B", "C", "F", "Unrated"]);
const GENERIC_RISK_TEXT =
  "earnings introduces two-sided volatility risk regardless of setup quality — that's true of any trade into a print";

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isFact(v: unknown): v is Fact {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).text === "string" &&
    (v as Record<string, unknown>).text !== ""
  );
}

// Strip ```json fences the model sometimes wraps responses in — same
// idiom as lib/perplexity.ts's unwrapJson, duplicated because that one
// isn't exported and this is a two-line pure function.
function unwrapJson(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

// Splits a single post at sentence boundaries so it fits `limit`,
// falling back to word-boundary wrapping only for a single sentence
// that alone exceeds the limit. Never truncates — every character in
// `text` (modulo whitespace normalization) ends up in the output.
// This is the enforcement backstop: the prompt asks the model to
// respect the limit itself, but this guarantees it structurally even
// if the model over- or under-shoots.
function splitAtSentenceBoundaries(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed.length > 0 ? [trimmed] : [];
  const sentences = trimmed.match(/[^.!?\n]+[.!?]?(\s+|\n+|$)/g) ?? [trimmed];
  const posts: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const candidate = current ? `${current} ${s}` : s;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) posts.push(current);
    if (s.length <= limit) {
      current = s;
      continue;
    }
    // A single sentence longer than the limit — hard-wrap on word
    // boundaries so nothing is dropped, never mid-word.
    let remainder = s;
    while (remainder.length > limit) {
      let cut = remainder.lastIndexOf(" ", limit);
      if (cut <= 0) cut = limit;
      posts.push(remainder.slice(0, cut).trim());
      remainder = remainder.slice(cut).trim();
    }
    current = remainder;
  }
  if (current) posts.push(current);
  return posts;
}

function enforcePostLimits(posts: unknown, limit: number): string[] {
  if (!Array.isArray(posts)) return [];
  return posts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .flatMap((p) => splitAtSentenceBoundaries(p, limit));
}

function buildPrompt(f: {
  symbol: string;
  strike: number;
  expiry: string | null;
  dte: number | null;
  grade: string;
  gradeIsPreview: boolean;
  strengths: Fact[];
  risk: { id: string; text: string; isDissent: boolean; keyMetric?: string };
  convictionNote: string;
  charLimit: number;
  variantCount: number;
}): string {
  const shortForm = f.charLimit <= 280;
  const whyAnyway = f.convictionNote.trim()
    ? `weave in my own note — "${f.convictionNote.trim()}" — naturally, in my voice, not tacked on as a separate final line`
    : "the strength below that most directly outweighs the risk";

  const variantBlocks = Array.from({ length: f.variantCount }, (_, i) => {
    // Rotate so each variant leads its strengths section with a
    // different fact — real differentiation (which reason comes
    // first), not reworded restatement of the same lead.
    const ordered = [f.strengths[i], ...f.strengths.filter((_, j) => j !== i)].filter(Boolean);
    const angle = ordered[0]?.id ?? "trade_setup";
    const strengthLines =
      ordered.length > 0
        ? ordered.map((s) => `  - ${s.text}`).join("\n")
        : "  - (none clear the bar for this candidate — keep this section brief and grounded in the assessment itself; do not invent a statistic to fill space)";
    return `VARIANT ${i + 1} (angle="${angle}"):\n${strengthLines}`;
  }).join("\n\n");

  return `You are drafting real social media posts (for X/Twitter) that a retail options trader will publish under their own name, disclosing a trade they are placing. Write in first person, plain and specific, and HONEST — this must read like genuine trader reasoning, not a pitch.

THE TRADE — open with a single line in this style: "Earnings play: selling the $${f.strike} put in $${f.symbol}"${f.expiry ? `, expiration ${f.expiry}${f.dte !== null ? ` (${f.dte}d out)` : ""} if it fits naturally in that line` : ""}. Do NOT recite "Earnings are [timing] on [date], with expiration on [date]" as a separate sentence — that's assumed context and wastes characters. A plain "Earnings play:" opener is enough.

MY ASSESSMENT: I have this graded as a ${f.grade}${f.gradeIsPreview ? " at this strike" : ""}. Present this as MY OWN read, in my voice — e.g. "I've got this as a ${f.grade}" — never as a system output like "Grade: ${f.grade}".

STRUCTURE — every variant follows this exact arc, in this order:
1. The trade (one line, per above)
2. The genuine strengths — the supporting facts listed for that variant below, IN THE ORDER GIVEN (that variant leads with the first one)
3. The real risk — stated plainly, not softened, not omitted
4. Why taking it anyway — ${whyAnyway}

Do NOT write a one-sided pitch. Stating the risk honestly, then explaining why I'm taking the trade anyway, is what makes this credible — skipping either the risk or the "why anyway" is a failed draft.

THE RISK (same for every variant):
${
  f.risk.isDissent
    ? `- A dedicated review of this ticker's own history flagged a concern: ${f.risk.text}${f.risk.keyMetric ? ` The thing to watch this print: ${f.risk.keyMetric}.` : ""} Acknowledge this concern directly and specifically — do not ignore it, and do not just restate it without responding to it. Then give the honest reason I'm taking the trade anyway.`
    : `- ${f.risk.text}`
}

FACTS RULE: do not invent any number, statistic, or claim beyond what's given in this prompt — for the strengths, the risk, or anything else.
${f.convictionNote.trim() ? `\nMY OWN NOTE ON THIS TRADE: "${f.convictionNote.trim()}"` : ""}

CONTENT RULES — violating any of these is a failed draft:
- Live figures ARE allowed and encouraged where given above: probability of profit, options flow ratios, delta, where the strike sits vs the expected move. Use them exactly as given — never invent, round differently, or alter one.
- Historical crush/EM pattern facts above are deliberately qualitative (a count of quarters, a description) — keep them that way in the draft; do not convert a count into a percentage or invent a ratio.
- NEVER mention: position size, number of contracts, premium collected, or any dollar amount other than the strike price itself. No account details.
- NEVER imply certainty about the outcome.
- NEVER give advice or use imperative language aimed at readers ("you should...", "consider selling..."). Disclosing MY OWN trade is fine ("selling the $${f.strike} put"); advice to the reader is not.
- NEVER use hype adjectives or vague confidence language ("setting up nicely", "watching this closely", "looks juicy").
- NEVER use thread-bait phrasing ("a thread 🧵", "let me explain", "here's why").
- No hashtags except a single ticker cashtag ($${f.symbol}) if it fits naturally. No hashtag spam.
- Minimal to no emoji.
- If a sentence could apply to literally any stock, cut it — be specific to this setup.

VARIANTS: generate exactly ${f.variantCount} variant(s). They differ in WHICH STRENGTH LEADS the strengths section, not in wording — three rephrasings of the same lead is a failed draft. The risk and why-anyway sections can repeat their content across variants (that's fine — it's the strengths lead that must differ):

${variantBlocks}

CHARACTER LIMIT: ${f.charLimit} characters per individual post (the "posts" array entries), not per variant.
${
  shortForm
    ? `This is short-form. Write the full case for each variant — trade, all its strengths, the risk, and the why-anyway — then split it across multiple posts in that variant's "posts" array. Break ONLY at the end of a complete thought or sentence — never mid-sentence — and don't pad every post out to exactly the limit. The opening post should run roughly 200 characters (a hook that fills the whole limit doesn't get read) and must lead with the trade plus that variant's lead strength, before anything else. Never drop content to fit the limit — add more posts instead.`
    : `This is long-form. Return exactly ONE post per variant (a single "posts" array entry with one string), but structure it internally with short line-broken sections covering the full arc (trade / strengths / risk / why-anyway) — the same readable rhythm a thread would have, not one dense paragraph.`
}

Return ONLY this JSON, no other text, no markdown fences:
{"variants":[{"angle":"<angle from the variant list above>","posts":["<post text>", "..."]}]}`;
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.symbol !== "string" || !body.symbol.trim()) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  const symbol = body.symbol.trim().toUpperCase();
  const strike = Number(body.strike);
  if (!Number.isFinite(strike) || strike <= 0) {
    return NextResponse.json({ error: "Missing or invalid strike" }, { status: 400 });
  }
  const grade = typeof body.grade === "string" && VALID_GRADES.has(body.grade) ? body.grade : "Unrated";
  const gradeIsPreview = body.gradeIsPreview === true;
  const convictionNote = typeof body.convictionNote === "string" ? body.convictionNote.slice(0, 500) : "";
  const expiry = isIsoDate(body.expiry) ? body.expiry : null;
  const earningsDate = isIsoDate(body.earningsDate) ? body.earningsDate : null;
  const dte = Number.isFinite(Number(body.dte)) ? Number(body.dte) : null;
  // Default 280, allow up to 2000 — a per-generation control, not a
  // saved preference. Clamped server-side regardless of what the
  // client sends.
  const charLimit = Math.min(2000, Math.max(50, Number(body.charLimit) || 280));

  const strengths = (Array.isArray(body.strengths) ? body.strengths : [])
    .filter(isFact)
    .slice(0, 4);
  const riskRaw = body.risk as
    | { id?: unknown; text?: unknown; isDissent?: unknown; keyMetric?: unknown }
    | null
    | undefined;
  const risk =
    riskRaw && typeof riskRaw.text === "string" && riskRaw.text
      ? {
          id: typeof riskRaw.id === "string" ? riskRaw.id : "risk",
          text: riskRaw.text,
          isDissent: riskRaw.isDissent === true,
          keyMetric: typeof riskRaw.keyMetric === "string" ? riskRaw.keyMetric : undefined,
        }
      : { id: "generic", text: GENERIC_RISK_TEXT, isDissent: false };

  // At least 1, at most 3 — tied to how much genuine, distinct
  // material is available. Padding to a fixed count with reworded
  // filler is exactly the failure mode this rework exists to remove.
  const variantCount = Math.max(1, Math.min(3, strengths.length || 1));

  const prompt = buildPrompt({
    symbol,
    strike,
    expiry,
    dte,
    grade,
    gradeIsPreview,
    strengths,
    risk,
    convictionNote,
    charLimit,
    variantCount,
  });

  const ppl = await askPerplexityRaw(prompt, {
    maxTokens: 3500,
    label: `tweet-draft:${symbol}`,
    timeoutMs: 45_000,
  });
  if (!ppl || !ppl.text.trim()) {
    return NextResponse.json({ error: "Draft generation failed — Perplexity unavailable" }, { status: 502 });
  }

  let parsed: { variants?: Array<{ angle?: unknown; posts?: unknown }> };
  try {
    parsed = JSON.parse(unwrapJson(ppl.text)) as typeof parsed;
  } catch {
    return NextResponse.json(
      { error: "Draft generation returned malformed output — try Regenerate" },
      { status: 502 },
    );
  }
  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    return NextResponse.json(
      { error: "Draft generation returned no variants — try Regenerate" },
      { status: 502 },
    );
  }

  const variants = parsed.variants
    .map((v) => ({
      angle: typeof v.angle === "string" && v.angle ? v.angle : "trade_setup",
      posts: enforcePostLimits(v.posts, charLimit),
    }))
    .filter((v) => v.posts.length > 0);

  if (variants.length === 0) {
    return NextResponse.json(
      { error: "Draft generation returned empty posts — try Regenerate" },
      { status: 502 },
    );
  }

  const sb = createServerClient();
  const ins = await sb
    .from("tweet_drafts")
    .insert({
      user_id: userId,
      symbol,
      strike,
      option_type: "put",
      expiry,
      earnings_date: earningsDate,
      conviction_note: convictionNote,
      char_limit: charLimit,
      grade,
      grade_is_preview: gradeIsPreview,
      variants,
    })
    .select("id")
    .single();
  if (ins.error) {
    console.warn(`[tweet-draft] persist failed for ${symbol}: ${ins.error.message}`);
  }

  return NextResponse.json({
    variants,
    draftId: ins.error ? null : (ins.data as { id: string }).id,
  });
}
