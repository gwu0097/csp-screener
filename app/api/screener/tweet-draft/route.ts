import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Drafts ONE trade-disclosure post (or thread, if it overflows the
// char limit) from facts already computed and scored client-side — no
// re-fetch of chain/news/history/Trade-Decision-Context here, the
// client already pulled whatever it needed. There used to be 2-3
// competing "variants," each built from a different SUBSET of the
// available facts — in practice they overlapped heavily on the
// obvious points while splitting the genuinely distinct ones across
// drafts no single post actually contained. One draft now, built from
// every qualifying strength plus the top risk facts, so nothing good
// gets left out. The LLM's only job is voice and structure: turn the
// full fact pool + the risk (which may be absent — no generic filler
// risk exists) into a strengths -> risk -> why-anyway draft. Position
// size, contract count, premium, and dollar amounts are simply never
// included in what's sent, so there's nothing to leak even by
// accident — but live figures (POP, options flow ratios, delta) the
// client marked as strong/risky ARE passed through and expected to
// appear verbatim.
export const maxDuration = 60;

type Fact = { id: string; text: string };
type Risk = Fact & { isDissent: boolean; keyMetric?: string };

type Body = {
  symbol?: unknown;
  strike?: unknown;
  expiry?: unknown;
  earningsDate?: unknown;
  dte?: unknown;
  grade?: unknown;
  gradeIsPreview?: unknown;
  strengths?: unknown; // Fact[] — the full qualifying pool, not a subset
  risks?: unknown; // Risk[], 0-2
  convictionNote?: unknown; // string
  charLimit?: unknown;
};

const VALID_GRADES = new Set(["A", "B", "C", "F", "Unrated"]);

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// "an A" / "an Unrated" / "a B" — the grade is always shown right
// after this article, so get it right rather than always saying "a".
function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
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

function toRisk(v: unknown): Risk | null {
  if (!isFact(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    id: v.id,
    text: v.text,
    isDissent: o.isDissent === true,
    keyMetric: typeof o.keyMetric === "string" ? o.keyMetric : undefined,
  };
}

// Strip ```json fences the model sometimes wraps responses in — same
// idiom as lib/perplexity.ts's unwrapJson, duplicated because that one
// isn't exported and this is a two-line pure function.
function unwrapJson(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

// Decimal points ("0.71", "1.9x") read as sentence-ending "."s to the
// tokenizer below, which excludes literal '.' from its "sentence body"
// character class. When a "." inside a number isn't followed by
// whitespace, the match at that position fails outright, the regex
// engine re-anchors at a LATER position to find one that succeeds, and
// everything between the stray "." and that later anchor — including
// the digits before the decimal point — is silently dropped from the
// output ("0.71" -> "71", "1.04" -> "04"). Swapping the "." in any
// digit-period-digit run for a placeholder before tokenizing (and back
// after) sidesteps the false terminator entirely without touching the
// splitting logic itself. Placeholder is a 1-for-1 character swap, so
// every length check downstream still sees the true character count.
const DECIMAL_PLACEHOLDER = "\u0001"; // control char, never appears in real text — kept as an explicit escape so it stays visible/greppable in source
function protectDecimals(text: string): string {
  return text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_PLACEHOLDER}$2`);
}
function restoreDecimals(text: string): string {
  return text.split(DECIMAL_PLACEHOLDER).join(".");
}

// Splits a single post at sentence boundaries so it fits `limit`,
// falling back to word-boundary wrapping only for a single sentence
// that alone exceeds the limit. Never truncates — every character in
// `text` (modulo whitespace normalization) ends up in the output.
// This is the enforcement backstop: the prompt asks the model to
// respect the limit itself, but this guarantees it structurally even
// if the model over- or under-shoots. limit=Infinity (an invalid or
// absent client value — char limit is now unclamped/unvalidated by
// design) short-circuits on the first check, so it's always safe.
function splitAtSentenceBoundaries(text: string, limit: number): string[] {
  const trimmed = protectDecimals(text.trim());
  if (trimmed.length <= limit) return trimmed.length > 0 ? [restoreDecimals(trimmed)] : [];
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
  return posts.map(restoreDecimals);
}

// The model returns ONE continuous piece of text — post count is
// never the model's decision. `raw` also accepts an array as a
// defensive fallback (join before splitting) in case the model
// reverts to a pre-split shape despite the prompt.
function enforcePostLimits(raw: unknown, limit: number): string[] {
  const text = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === "string").join("\n\n")
      : "";
  return splitAtSentenceBoundaries(text, limit);
}

function buildPrompt(f: {
  symbol: string;
  strike: number;
  expiry: string | null;
  dte: number | null;
  grade: string;
  gradeIsPreview: boolean;
  strengths: Fact[];
  risks: Risk[];
  convictionNote: string;
  charLimit: number;
}): string {
  const shortForm = f.charLimit <= 280;
  const hasRisk = f.risks.length > 0;
  const whyAnyway = f.convictionNote.trim()
    ? `weave in my own note — "${f.convictionNote.trim()}" — naturally, in my voice, not tacked on as a separate final line`
    : "the strength that most directly outweighs the risk";
  const article = articleFor(f.grade);

  const strengthLines =
    f.strengths.length > 0
      ? f.strengths.map((s) => `  - ${s.text}`).join("\n")
      : "  - (none clear the bar — keep the case brief and grounded in the assessment itself; do not invent a statistic to fill space)";

  // "if it fits naturally" made this discretionary — the model
  // included it in one generation and dropped it in another, same
  // run. Every field named here is now mandatory whenever the data
  // exists, in a fixed position, so the opener is identical in shape
  // across every draft.
  const tradeLine =
    f.expiry !== null
      ? `open with a single line in EXACTLY this shape, every time: "Earnings play: selling the $${f.strike} put in $${f.symbol}, expiring ${f.expiry}"${f.dte !== null ? ` — you may add "(${f.dte}d out)" right after the date, but the date itself` : " — the date"} is mandatory in that position every single generation, never optional, never dropped`
      : `open with a single line in this style: "Earnings play: selling the $${f.strike} put in $${f.symbol}"`;

  const riskBlock = hasRisk
    ? `THE RISK (step 4 of the structure):
${f.risks
  .map((r) =>
    r.isDissent
      ? `- A dedicated review of this ticker's own history flagged a concern: ${r.text}${r.keyMetric ? ` The thing to watch this print: ${r.keyMetric}.` : ""} Acknowledge this concern directly and specifically — do not ignore it, and do not just restate it without responding to it.`
      : `- ${r.text}`,
  )
  .join("\n")}
Then explain your reasoning for proceeding despite it.`
    : `THE RISK: none of the available signals cleared a real risk bar for this trade — there is nothing specific and material to report. DO NOT invent one, and do NOT fill this slot with a category-generic statement ("earnings is volatile", "options carry risk", "the stock could move against me", "there's always risk in any trade") — those are banned regardless of how the risk section is filled elsewhere. Skip the risk step and the reasoning-for-proceeding step entirely — go from strengths straight to the close (the conviction note, if given, or nothing extra).`;

  return `You are drafting a real social media post (for X/Twitter) that a retail options trader will publish under their own name, disclosing a trade they are placing. Write in first person, plain and specific, and HONEST — this must read like genuine trader reasoning, not a pitch.

THE TRADE — ${tradeLine}. Do NOT recite "Earnings are [timing] on [date], with expiration on [date]" as a separate sentence — that's assumed context and wastes characters; the trade line above is the only place expiration needs to appear.

MY ASSESSMENT: I have this graded as ${article} ${f.grade}${f.gradeIsPreview ? " at this strike" : ""}. State this with a first-person VERB connecting you to the grade — e.g. a word like "grade", "call", "rate", "read", "have", or similar, your choice, vary which one across generations. Two things are equally banned here: (1) a bare system readout with no verb at all, like "Grade: ${f.grade}" or just "${f.grade}." sitting on its own as a sentence — a letter grade with nothing connecting it to you reads exactly like the system output this whole instruction exists to avoid; (2) a possessive qualifier tacked onto the verb to underline it's your opinion — avoid "in my book", "on my desk", "from my side", "in my view", "on my sheet", "in my own read", or any other "my [noun]" construction. The first-person verb by itself is both necessary and sufficient — it makes the grade a personal take without a bare readout, and a possessive on top of it is redundant.

STRUCTURE — this arc, in this order:
1. The trade (one line, per above)
2. My grade/assessment (see MY ASSESSMENT)
3. The genuine strengths — ALL of the facts listed below; this is the full qualifying pool, not a sample to pick from, so every one of them should appear
4. Acknowledge the concern below, in my own words, only if one is given (see THE RISK; may be two related concerns stated together)
5. My reasoning for proceeding despite that concern, only if one was stated in step 4 — ${whyAnyway}

${hasRisk ? "Do NOT write a one-sided pitch. Naming the concern honestly, then explaining your reasoning for proceeding despite it, is what makes this credible — skipping either half when a real concern IS given below is a failed draft." : "There is no concern to state this time (see THE RISK below) — do not manufacture one just to fill the slot."}

THE STRENGTHS (step 3 — use every one, don't drop any to save space; use more posts instead, see CHARACTER LIMIT below):
${strengthLines}

${riskBlock}

FACTS RULE: do not invent any number, statistic, or claim beyond what's given in this prompt — for the strengths, the risk, or anything else.
${f.convictionNote.trim() ? `\nMY OWN NOTE ON THIS TRADE: "${f.convictionNote.trim()}"` : ""}

CONTENT RULES — violating any of these is a failed draft:
- Live figures ARE allowed and encouraged where given above: probability of profit, options flow ratios, delta, where the strike sits vs the expected move. Use them exactly as given — never invent, round differently, or alter one.
- Historical crush/EM pattern facts above are deliberately qualitative (a count of quarters, a description) — keep them that way in the draft; do not convert a count into a percentage or invent a ratio.
- BANNED: any statement that would be equally true of any trade in the same category, not specific to this ticker/setup/strike. Examples of banned phrasing: "earnings is volatile", "options carry risk", "the stock could move against me", "anything can happen into a print", "there's always risk in any trade". If a sentence could be pasted into a tweet about a completely different stock unchanged, cut it — every claim must trace to a specific fact given above.
- NEVER mention: position size, number of contracts, premium collected, or any dollar amount other than the strike price itself. No account details.
- NEVER imply certainty about the outcome.
- NEVER give advice or use imperative language aimed at readers ("you should...", "consider selling..."). Disclosing MY OWN trade is fine ("selling the $${f.strike} put"); advice to the reader is not.
- NEVER use hype adjectives or vague confidence language ("setting up nicely", "watching this closely", "looks juicy").
- NEVER use thread-bait phrasing ("a thread 🧵", "let me explain", "here's why").
- No hashtags except a single ticker cashtag ($${f.symbol}) if it fits naturally. No hashtag spam.
- Minimal to no emoji.

CHARACTER LIMIT: ${Number.isFinite(f.charLimit) ? f.charLimit : "none — write as long as the content genuinely needs, no padding"} characters, applied automatically AFTER you write — see OUTPUT FORMAT below. Write the full case as ONE continuous piece of text — do not decide post boundaries yourself, do not write "Post 1/3", do not restate the trade line or grade partway through, do not pre-split into a thread. Just write it as continuous prose covering every strength listed above plus the risk arc if any.

SENTENCE LENGTH: the process that splits your text into posts can only break between sentences, never mid-sentence — so a single long sentence has to land whole in one post, which can strand a short post with wasted room if the sentence right after it doesn't fit alongside it. Keep sentences short and roughly EVEN in length — aim for around 80-130 characters each, well under a fifth of the limit — rather than a few long ones. Splitting a single idea across two shorter sentences instead of one long one gives the splitter more places to pack tightly; it costs nothing in meaning.
${
  shortForm
    ? `This will likely need to split into multiple posts once it's measured against the limit — that's expected and handled automatically, becoming a thread. Just make sure the opening sentences state the trade plus the single strongest strength before anything else, so if it does split, the first chunk is a real hook on its own — and every strength still needs to appear somewhere in the thread, not just the ones that fit the first post.`
    : `This may fit in a single post once measured against the limit — structure the prose internally with short line-broken sections covering the full arc, the same readable rhythm a thread would have, not one dense paragraph. Use the room the limit gives you: every strength listed above, plus the risk and why-anyway if any, should actually appear, with enough surrounding context to read as reasoning rather than a bare list — don't stop early or compress the case just because a shorter version would also technically fit. Padding with filler is still banned; the point is to not truncate genuine material for no reason. If the full case genuinely doesn't fit even at this limit, it's fine to run over into a second post — never drop a strength to stay under.`
}

Return ONLY this JSON, no other text, no markdown fences:
{"text":"<the full continuous prose>"}`;
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
  // No clamping, no minimum — freeform by design. A non-finite or
  // non-positive value (empty field, stray text, 0, negative) is
  // treated as "no limit" rather than crashing the splitter or
  // silently substituting a default the user didn't ask for.
  const rawCharLimit = Number(body.charLimit);
  const charLimit = Number.isFinite(rawCharLimit) && rawCharLimit > 0 ? rawCharLimit : Infinity;

  // Server-side cap is a defensive backstop (this endpoint is
  // auth-gated but still a network boundary), not a business rule —
  // the client already scales its own cap with charLimit and there are
  // only ~10 possible strength sources in the whole candidate pool, so
  // this is generous on purpose: it should never actually bind.
  const strengths = (Array.isArray(body.strengths) ? body.strengths : [])
    .filter(isFact)
    .slice(0, 12);

  // No generic fallback — a request with no genuine risk simply has an
  // empty risks array, and the draft omits the risk section entirely
  // rather than filling it with a category-generic placeholder. Up to
  // two compound risks (e.g. a mediocre crush record AND the deep-OTM
  // cluster) can appear together.
  const risks = (Array.isArray(body.risks) ? body.risks : [])
    .map(toRisk)
    .filter((r): r is Risk => r !== null)
    .slice(0, 2);

  const prompt = buildPrompt({
    symbol,
    strike,
    expiry,
    dte,
    grade,
    gradeIsPreview,
    strengths,
    risks,
    convictionNote,
    charLimit,
  });

  const ppl = await askPerplexityRaw(prompt, {
    maxTokens: 3500,
    label: `tweet-draft:${symbol}`,
    timeoutMs: 45_000,
  });
  if (!ppl || !ppl.text.trim()) {
    return NextResponse.json({ error: "Draft generation failed — Perplexity unavailable" }, { status: 502 });
  }

  let parsed: { text?: unknown; posts?: unknown };
  try {
    parsed = JSON.parse(unwrapJson(ppl.text)) as typeof parsed;
  } catch {
    return NextResponse.json(
      { error: "Draft generation returned malformed output — try Regenerate" },
      { status: 502 },
    );
  }

  const posts = enforcePostLimits(typeof parsed.text === "string" ? parsed.text : parsed.posts, charLimit);
  if (posts.length === 0) {
    return NextResponse.json(
      { error: "Draft generation returned empty content — try Regenerate" },
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
      char_limit: Number.isFinite(charLimit) ? charLimit : null,
      grade,
      grade_is_preview: gradeIsPreview,
      variants: posts,
    })
    .select("id")
    .single();
  if (ins.error) {
    console.warn(`[tweet-draft] persist failed for ${symbol}: ${ins.error.message}`);
  }

  return NextResponse.json({
    posts,
    draftId: ins.error ? null : (ins.data as { id: string }).id,
  });
}
