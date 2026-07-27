import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Drafts trade-disclosure posts from facts already computed client-side
// (grade, crush pattern, strike-vs-EM positioning, conviction note) —
// no re-fetch of chain/news/history here. The LLM's only job is voice
// and structure; every number it's allowed to reference is handed to
// it pre-computed, and premium/size/POP are never included in the
// prompt at all, so there's nothing for it to leak even by accident.
export const maxDuration = 60;

type Angle = "crush_reliability" | "em_positioning" | "conviction" | "trade_setup";

type Body = {
  symbol?: unknown;
  strike?: unknown;
  expiry?: unknown;
  earningsDate?: unknown;
  earningsTiming?: unknown;
  dte?: unknown;
  grade?: unknown;
  gradeIsPreview?: unknown;
  crushPatternFact?: unknown; // string | null
  emPositionFact?: unknown; // string | null
  convictionNote?: unknown; // string
  charLimit?: unknown;
};

const VALID_GRADES = new Set(["A", "B", "C", "F", "Unrated"]);

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
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
  earningsDate: string | null;
  earningsTiming: string | null;
  dte: number | null;
  grade: string;
  gradeIsPreview: boolean;
  crushPatternFact: string | null;
  emPositionFact: string | null;
  convictionNote: string;
  charLimit: number;
  angles: Angle[];
}): string {
  const angleDescriptions: Record<Angle, string> = {
    crush_reliability: `crush reliability — leads with: ${f.crushPatternFact}`,
    em_positioning: `strike positioning — leads with: the strike ${f.emPositionFact}`,
    conviction: `my own conviction/note — leads with the note itself, woven in naturally`,
    trade_setup: `the trade setup itself — leads with the mechanics (symbol, strike, timing relative to earnings), not a pattern claim`,
  };

  const factLines: string[] = [];
  if (f.crushPatternFact) factLines.push(`- Crush reliability pattern: ${f.crushPatternFact}`);
  if (f.emPositionFact) factLines.push(`- Strike positioning: the strike ${f.emPositionFact}`);
  if (f.convictionNote.trim()) {
    factLines.push(
      `- My own note on this trade: "${f.convictionNote.trim()}" — weave this in naturally in my voice, don't tack it on as a final separate line.`,
    );
  }

  const shortForm = f.charLimit <= 280;

  return `You are drafting real social media posts (for X/Twitter) that a retail options trader will publish under their own name, disclosing a trade they are placing. Write in first person, plain and specific.

THE TRADE:
- ${f.symbol}, selling the $${f.strike} put
${f.expiry ? `- Expiration: ${f.expiry}${f.dte !== null ? ` (${f.dte} days out)` : ""}` : ""}
${f.earningsDate ? `- Reports earnings ${f.earningsTiming ?? ""} on ${f.earningsDate}` : ""}

MY ASSESSMENT: I have this graded as a ${f.grade}${f.gradeIsPreview ? " at this strike" : ""}. Present this as MY OWN read, in my voice — e.g. "I've got this as a ${f.grade}" — never as a system output like "Grade: ${f.grade}".

FACTS YOU MAY USE — do not invent any number, statistic, or fact beyond what's listed here:
${factLines.length > 0 ? factLines.join("\n") : "- (no additional pattern facts available — lead with the trade setup itself)"}

STRICT CONTENT RULES — violating any of these is a failed draft:
- NEVER mention: position size, number of contracts, premium collected, any dollar amount other than the strike price itself, probability of profit or "POP" (as a number or as a bare claim), delta, or account details.
- NEVER use hype adjectives or vague confidence language: "setting up nicely", "watching this closely", "looks juicy", or similar.
- NEVER imply certainty about the outcome.
- NEVER give advice or use imperative language aimed at readers ("you should...", "consider selling..."). Disclosing MY OWN trade is fine ("selling the $${f.strike} put into earnings"); advice to the reader is not.
- NEVER use thread-bait phrasing ("a thread 🧵", "let me explain", "here's why", etc).
- No hashtags except a single ticker cashtag ($${f.symbol}) if it fits naturally. No hashtag spam.
- Minimal to no emoji.
- If a sentence could apply to literally any stock, cut it — be specific to this setup.

VARIANTS: generate exactly ${f.angles.length} variants, each keyed to a different angle below. They must differ in WHICH REASON THEY LEAD WITH, not in wording — three rephrasings of the same lead is a failed draft.
${f.angles.map((a, i) => `${i + 1}. angle="${a}" — ${angleDescriptions[a]}`).join("\n")}
Every variant should still mention the trade and the grade; only the opening/leading reason changes.

CHARACTER LIMIT: ${f.charLimit} characters per individual post (the "posts" array entries), not per variant.
${
  shortForm
    ? `This is short-form. Write the full case for each variant, then split it across multiple posts in that variant's "posts" array. Break ONLY at the end of a complete thought or sentence — never mid-sentence — and don't pad every post out to exactly the limit. The opening post should run roughly 200 characters (a hook that fills the whole limit doesn't get read) and must lead with the trade plus that variant's single strongest reason, before anything else. Never drop analysis to fit the limit — add more posts instead of cutting content.`
    : `This is long-form. Return exactly ONE post per variant (a single "posts" array entry with one string), but structure it internally with short line-broken sections — the same readable rhythm a thread would have, not one dense paragraph. The opening lines must state the trade plus that variant's single strongest reason, before anything else.`
}

Return ONLY this JSON, no other text, no markdown fences:
{"variants":[{"angle":"<one of: ${f.angles.join(", ")}>","posts":["<post text>", "..."]}]}`;
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
  const crushPatternFact = typeof body.crushPatternFact === "string" ? body.crushPatternFact : null;
  const emPositionFact = typeof body.emPositionFact === "string" ? body.emPositionFact : null;
  const convictionNote = typeof body.convictionNote === "string" ? body.convictionNote.slice(0, 500) : "";
  const expiry = isIsoDate(body.expiry) ? body.expiry : null;
  const earningsDate = isIsoDate(body.earningsDate) ? body.earningsDate : null;
  const earningsTiming = typeof body.earningsTiming === "string" ? body.earningsTiming : null;
  const dte = Number.isFinite(Number(body.dte)) ? Number(body.dte) : null;
  // Default 280, allow up to 2000 — a per-generation control, not a
  // saved preference. Clamped server-side regardless of what the
  // client sends.
  const charLimit = Math.min(2000, Math.max(50, Number(body.charLimit) || 280));

  const angles: Angle[] = [];
  if (crushPatternFact) angles.push("crush_reliability");
  if (emPositionFact) angles.push("em_positioning");
  if (convictionNote.trim()) angles.push("conviction");
  // Always-available fallback so there are never fewer than 2 angles
  // to choose between, without ever forcing a fabricated fact.
  if (angles.length < 2) angles.push("trade_setup");
  const finalAngles = angles.slice(0, 3);

  const prompt = buildPrompt({
    symbol,
    strike,
    expiry,
    earningsDate,
    earningsTiming,
    dte,
    grade,
    gradeIsPreview,
    crushPatternFact,
    emPositionFact,
    convictionNote,
    charLimit,
    angles: finalAngles,
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
    .map((v) => {
      const angle: Angle = finalAngles.includes(v.angle as Angle) ? (v.angle as Angle) : finalAngles[0];
      const posts = enforcePostLimits(v.posts, charLimit);
      return { angle, posts };
    })
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
