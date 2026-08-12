import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  buildDictionaryMap,
  classifyObservations,
  validateObservationResolutions,
  type ObservationClassification,
  type ObservationDictionaryEntry,
  type ObservationKind,
  type ObservationResolutions,
  type ParsedCandidateObservation,
} from "@/lib/observation-dictionary";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Advisory-only research analysis storage — pasted back from an
// external LLM conversation seeded by the Analysis Dump tab's
// ANALYSIS_TEMPLATE (lib/analysis-dump-template.ts). Never feeds any
// calculation; this route only reads/writes research_analyses. No auth
// gate, matching this route's closest siblings (earnings-history/update,
// fetch-em-history) — research_analyses is shared market analysis, not
// a per-user table.

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_BATCH_SYMBOLS = 200;

// GET /api/screener/research-analysis?symbol=APP
// Returns every stored analysis for the symbol (there are at most a
// handful per ticker) — the History tab matches by earnings_date
// client-side, and the paste-back UI uses it to detect an existing
// analysis for the current quarter before overwriting.
//
// GET /api/screener/research-analysis?symbols=APP,ELF,TTWO
// Batch form for the candidates table's AI-analysis indicator — one
// query for the whole screen instead of one per row. Returns only the
// columns that badge needs (not raw_paste/analysis_prose); callers
// still match on BOTH symbol and earnings_date client-side, since this
// intentionally returns every stored quarter per symbol, not just the
// current candidate's.
export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols");
  if (symbolsParam !== null) {
    const symbols = Array.from(
      new Set(
        symbolsParam
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => SYMBOL_RE.test(s)),
      ),
    );
    if (symbols.length === 0) {
      return NextResponse.json({ analyses: [] });
    }
    if (symbols.length > MAX_BATCH_SYMBOLS) {
      return NextResponse.json(
        { error: `Too many symbols (max ${MAX_BATCH_SYMBOLS})` },
        { status: 400 },
      );
    }
    const sb = createServerClient();
    const res = await sb
      .from("research_analyses")
      .select("symbol,earnings_date,checklist_version,updated_at")
      .in("symbol", symbols);
    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
    return NextResponse.json({ analyses: res.data ?? [] });
  }

  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "Invalid or missing symbol" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from("research_analyses")
    .select("*")
    .eq("symbol", symbol)
    .order("earnings_date", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ analyses: res.data ?? [] });
}

type Body = {
  symbol?: unknown;
  earningsDate?: unknown;
  flagsFired?: unknown;
  flagsNa?: unknown;
  flagsUnknown?: unknown;
  candidateFlags?: unknown;
  candidateObservations?: unknown;
  observationResolutions?: unknown;
  checklistVersion?: unknown;
  templateVersion?: unknown;
  analysisProse?: unknown;
  rawPaste?: unknown;
  parseStatus?: unknown;
  referenceStrike?: unknown;
  spotAtAnalysis?: unknown;
  emPctAtAnalysis?: unknown;
  numericGrade?: unknown;
  crushGrade?: unknown;
  maxDownsideRatio?: unknown;
  // Added 2026-08-11 (audit: prose-only recommendation/catalyst
  // couldn't be scored). All optional/nullable — a save from a paste
  // written against a pre-2026-08-11 template simply omits these.
  recommendation?: unknown;
  recommendedStrike?: unknown;
  downCatalyst?: unknown;
  downCatalystPlausibility?: unknown;
  // Nullable link to the position this analysis preceded. Most
  // analyses are passes with no position — omitted/null is the common
  // case, not an error.
  positionId?: unknown;
  // Added 2026-08-11 (v6 template) — the field the prediction log
  // scores. Optional/nullable, same as the four fields above.
  leftTailRisk?: unknown;
};

function asStringArray(v: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  return { ok: true, value: v };
}

function asNullableNumber(v: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { ok: false, error: `${field} must be a finite number or null` };
  }
  return { ok: true, value: v };
}

function asNullableEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): { ok: true; value: T | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return { ok: false, error: `${field} must be one of ${allowed.join(", ")}, or null` };
  }
  return { ok: true, value: v as T };
}

function asNullableBoolean(v: unknown, field: string): { ok: true; value: boolean | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "boolean") {
    return { ok: false, error: `${field} must be a boolean or null` };
  }
  return { ok: true, value: v };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asNullableUuid(v: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    return { ok: false, error: `${field} must be a UUID string or null` };
  }
  return { ok: true, value: v };
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const OBSERVATION_TERM_RE = /^[a-z][a-z0-9_]*$/;

// undefined (field omitted) means "this is a legacy v1-v3 save, no
// observation pipeline" — distinct from `[]` (a v4 save that genuinely
// found zero observations this time, which still needs to sync away any
// previously-recorded usages for this analysis).
function asObservationList(
  v: unknown,
): { ok: true; value: ParsedCandidateObservation[] | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(v)) return { ok: false, error: "candidateObservations must be an array" };
  const out: ParsedCandidateObservation[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "candidateObservations entries must be objects" };
    }
    const rec = item as Record<string, unknown>;
    const term = rec.term;
    const definition = rec.definition;
    if (typeof term !== "string" || !OBSERVATION_TERM_RE.test(term)) {
      return { ok: false, error: `Invalid observation term: ${JSON.stringify(term)}` };
    }
    if (definition !== null && definition !== undefined && typeof definition !== "string") {
      return { ok: false, error: `Invalid observation definition for term "${term}"` };
    }
    if (seen.has(term)) continue; // client should already dedupe; defensive only
    seen.add(term);
    out.push({ term, definition: typeof definition === "string" ? definition : null });
  }
  return { ok: true, value: out };
}

function asObservationResolutions(v: unknown): ObservationResolutions {
  const empty: ObservationResolutions = { newTermKinds: {}, useNewDefinitionFor: [] };
  if (typeof v !== "object" || v === null) return empty;
  const rec = v as Record<string, unknown>;
  const newTermKinds: Record<string, ObservationKind> = {};
  if (typeof rec.newTermKinds === "object" && rec.newTermKinds !== null) {
    for (const [term, kind] of Object.entries(rec.newTermKinds as Record<string, unknown>)) {
      if (kind === "setup_observation" || kind === "app_defect") newTermKinds[term] = kind;
    }
  }
  const useNewDefinitionFor = Array.isArray(rec.useNewDefinitionFor)
    ? rec.useNewDefinitionFor.filter((x): x is string => typeof x === "string")
    : [];
  return { newTermKinds, useNewDefinitionFor };
}

// Inserts brand-new terms and, only where the caller explicitly chose to
// overwrite (resolutions.useNewDefinitionFor), updates a redefined term's
// stored definition. Reused terms (bare or matching) get no dictionary
// write here — use_count/last_used_at are handled entirely by
// syncObservationUsages below, recomputed from observation_usages rather
// than incremented, so a re-save of the same analysis never drifts.
async function upsertDictionaryTerms(
  sb: ReturnType<typeof createServerClient>,
  classifications: ObservationClassification[],
  resolutions: ObservationResolutions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  for (const c of classifications) {
    if (c.status === "new_with_definition") {
      const kind = resolutions.newTermKinds[c.term];
      const insRes = await sb.from("observation_dictionary").insert({
        term: c.term,
        definition: c.definition,
        kind,
        use_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (insRes.error) return { ok: false, error: insRes.error.message };
    } else if (c.status === "existing_redefined" && resolutions.useNewDefinitionFor.includes(c.term)) {
      const updRes = await sb
        .from("observation_dictionary")
        .update({ definition: c.newDefinition, updated_at: nowIso })
        .eq("term", c.term);
      if (updRes.error) return { ok: false, error: updRes.error.message };
    }
  }
  return { ok: true };
}

// Reconciles observation_usages for (symbol, earningsDate) against the
// terms used in THIS save — a diff/sync, not an append, so re-saving the
// same analysis (the paste/revise/save loop this UI is built around)
// never double-counts. For every term whose usage set for this analysis
// changed (added or removed), use_count/first_used_at/last_used_at are
// recomputed from the full observation_usages table for that term, not
// incremented — a blind +1/-1 would drift on any partial-failure retry.
async function syncObservationUsages(
  sb: ReturnType<typeof createServerClient>,
  symbol: string,
  earningsDate: string,
  newTerms: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existingRes = await sb
    .from("observation_usages")
    .select("term")
    .eq("symbol", symbol)
    .eq("earnings_date", earningsDate);
  if (existingRes.error) return { ok: false, error: existingRes.error.message };
  const existingTerms = new Set(((existingRes.data ?? []) as { term: string }[]).map((r) => r.term));
  const newTermSet = new Set(newTerms);

  const toDelete = Array.from(existingTerms).filter((t) => !newTermSet.has(t));
  const toInsert = Array.from(newTermSet).filter((t) => !existingTerms.has(t));

  for (const term of toDelete) {
    const delRes = await sb
      .from("observation_usages")
      .delete()
      .eq("term", term)
      .eq("symbol", symbol)
      .eq("earnings_date", earningsDate);
    if (delRes.error) return { ok: false, error: delRes.error.message };
  }

  if (toInsert.length > 0) {
    const insRes = await sb
      .from("observation_usages")
      .insert(toInsert.map((term) => ({ term, symbol, earnings_date: earningsDate })));
    if (insRes.error) return { ok: false, error: insRes.error.message };
  }

  const affected = Array.from(new Set([...toDelete, ...toInsert]));
  for (const term of affected) {
    const usagesRes = await sb.from("observation_usages").select("created_at").eq("term", term);
    if (usagesRes.error) return { ok: false, error: usagesRes.error.message };
    const rows = (usagesRes.data ?? []) as { created_at: string }[];
    const times = rows.map((r) => new Date(r.created_at).getTime()).filter((t) => !Number.isNaN(t));
    const updRes = await sb
      .from("observation_dictionary")
      .update({
        use_count: rows.length,
        first_used_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        last_used_at: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("term", term);
    if (updRes.error) return { ok: false, error: updRes.error.message };
  }

  return { ok: true };
}

// POST — saves (upserts) one analysis, keyed by (symbol, earnings_date).
// A re-paste for the same quarter overwrites, not duplicates — the
// spec explicitly calls the row "editable and re-saveable."
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const earningsDate = typeof body.earningsDate === "string" ? body.earningsDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) {
    return NextResponse.json({ error: "Invalid earningsDate (expected YYYY-MM-DD)" }, { status: 400 });
  }
  const rawPaste = typeof body.rawPaste === "string" ? body.rawPaste : "";
  if (!rawPaste) {
    return NextResponse.json({ error: "rawPaste is required — the verbatim pasted text" }, { status: 400 });
  }
  const parseStatus = body.parseStatus;
  if (parseStatus !== "parsed" && parseStatus !== "prose_only" && parseStatus !== "partial") {
    return NextResponse.json(
      { error: "parseStatus must be one of 'parsed' | 'prose_only' | 'partial'" },
      { status: 400 },
    );
  }

  const flagsFired = asStringArray(body.flagsFired, "flagsFired");
  if (!flagsFired.ok) return NextResponse.json({ error: flagsFired.error }, { status: 400 });
  const flagsNa = asStringArray(body.flagsNa, "flagsNa");
  if (!flagsNa.ok) return NextResponse.json({ error: flagsNa.error }, { status: 400 });
  const flagsUnknown = asStringArray(body.flagsUnknown, "flagsUnknown");
  if (!flagsUnknown.ok) return NextResponse.json({ error: flagsUnknown.error }, { status: 400 });
  const candidateFlags = asStringArray(body.candidateFlags, "candidateFlags");
  if (!candidateFlags.ok) return NextResponse.json({ error: candidateFlags.error }, { status: 400 });

  const candidateObservations = asObservationList(body.candidateObservations);
  if (!candidateObservations.ok) {
    return NextResponse.json({ error: candidateObservations.error }, { status: 400 });
  }
  const observationResolutions = asObservationResolutions(body.observationResolutions);

  // candidateObservations present (even as []) marks a v4-shaped save —
  // classify against the current dictionary and reject before writing
  // anything if a term is new-without-a-definition or a new term has no
  // chosen kind. Absent means a legacy v1-v3 save; candidate_flags below
  // is then taken verbatim from the client as before.
  let observationClassifications: ObservationClassification[] = [];
  const sb = createServerClient();
  if (candidateObservations.value !== undefined) {
    const terms = Array.from(new Set(candidateObservations.value.map((o) => o.term)));
    let dictionaryEntries: ObservationDictionaryEntry[] = [];
    if (terms.length > 0) {
      const dictRes = await sb.from("observation_dictionary").select("*").in("term", terms);
      if (dictRes.error) {
        return NextResponse.json({ error: dictRes.error.message }, { status: 500 });
      }
      dictionaryEntries = (dictRes.data ?? []) as ObservationDictionaryEntry[];
    }
    observationClassifications = classifyObservations(
      candidateObservations.value,
      buildDictionaryMap(dictionaryEntries),
    );
    const validation = validateObservationResolutions(observationClassifications, observationResolutions);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  const referenceStrike = asNullableNumber(body.referenceStrike, "referenceStrike");
  if (!referenceStrike.ok) return NextResponse.json({ error: referenceStrike.error }, { status: 400 });
  const spotAtAnalysis = asNullableNumber(body.spotAtAnalysis, "spotAtAnalysis");
  if (!spotAtAnalysis.ok) return NextResponse.json({ error: spotAtAnalysis.error }, { status: 400 });
  const emPctAtAnalysis = asNullableNumber(body.emPctAtAnalysis, "emPctAtAnalysis");
  if (!emPctAtAnalysis.ok) return NextResponse.json({ error: emPctAtAnalysis.error }, { status: 400 });
  const maxDownsideRatio = asNullableNumber(body.maxDownsideRatio, "maxDownsideRatio");
  if (!maxDownsideRatio.ok) return NextResponse.json({ error: maxDownsideRatio.error }, { status: 400 });

  const recommendation = asNullableEnum(body.recommendation, "recommendation", ["take", "take_smaller", "pass"] as const);
  if (!recommendation.ok) return NextResponse.json({ error: recommendation.error }, { status: 400 });
  const recommendedStrike = asNullableNumber(body.recommendedStrike, "recommendedStrike");
  if (!recommendedStrike.ok) return NextResponse.json({ error: recommendedStrike.error }, { status: 400 });
  const downCatalystPlausibility = asNullableEnum(
    body.downCatalystPlausibility,
    "downCatalystPlausibility",
    ["low", "moderate", "high", "n/a"] as const,
  );
  if (!downCatalystPlausibility.ok) {
    return NextResponse.json({ error: downCatalystPlausibility.error }, { status: 400 });
  }
  const positionId = asNullableUuid(body.positionId, "positionId");
  if (!positionId.ok) return NextResponse.json({ error: positionId.error }, { status: 400 });
  const leftTailRisk = asNullableBoolean(body.leftTailRisk, "leftTailRisk");
  if (!leftTailRisk.ok) return NextResponse.json({ error: leftTailRisk.error }, { status: 400 });

  // v4 saves derive candidate_flags from the observation term list
  // server-side rather than trusting the client's flat array, so the
  // History tab / modal / this route's own savedRecord panel — which all
  // read candidate_flags directly and are out of scope for this phase —
  // keep working unchanged for v4 records too.
  const finalCandidateFlags =
    candidateObservations.value !== undefined
      ? Array.from(new Set(candidateObservations.value.map((o) => o.term)))
      : candidateFlags.value;

  const up = await sb
    .from("research_analyses")
    .upsert(
      {
        symbol,
        earnings_date: earningsDate,
        flags_fired: flagsFired.value,
        flags_na: flagsNa.value,
        flags_unknown: flagsUnknown.value,
        candidate_flags: finalCandidateFlags,
        checklist_version: asNullableString(body.checklistVersion),
        template_version: asNullableString(body.templateVersion),
        analysis_prose: asNullableString(body.analysisProse),
        raw_paste: rawPaste,
        parse_status: parseStatus,
        reference_strike: referenceStrike.value,
        spot_at_analysis: spotAtAnalysis.value,
        em_pct_at_analysis: emPctAtAnalysis.value,
        numeric_grade: asNullableString(body.numericGrade),
        crush_grade: asNullableString(body.crushGrade),
        max_downside_ratio: maxDownsideRatio.value,
        recommendation: recommendation.value,
        recommended_strike: recommendedStrike.value,
        down_catalyst: asNullableString(body.downCatalyst),
        down_catalyst_plausibility: downCatalystPlausibility.value,
        position_id: positionId.value,
        left_tail_risk: leftTailRisk.value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "symbol,earnings_date" },
    )
    .select()
    .single();
  if (up.error) {
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  // Dictionary + usages writes happen only after the analysis row is
  // safely saved, and are ordered new-terms-then-usages so a mid-failure
  // retry is recoverable: observation_usages has a unique(term, symbol,
  // earnings_date) constraint and syncObservationUsages recomputes
  // use_count from source of truth rather than incrementing, so replaying
  // this tail after a partial failure is idempotent, not double-counted.
  if (candidateObservations.value !== undefined) {
    const dictRes = await upsertDictionaryTerms(sb, observationClassifications, observationResolutions);
    if (!dictRes.ok) {
      return NextResponse.json(
        { error: `Analysis saved, but the observation dictionary update failed: ${dictRes.error}` },
        { status: 500 },
      );
    }
    const usagesRes = await syncObservationUsages(sb, symbol, earningsDate, finalCandidateFlags);
    if (!usagesRes.ok) {
      return NextResponse.json(
        { error: `Analysis saved, but observation usage tracking failed: ${usagesRes.error}` },
        { status: 500 },
      );
    }
  }

  // Returning the upserted row lets the paste-back UI rehydrate the
  // textarea from exactly what's now persisted, instead of clearing it
  // or re-fetching separately — this is an iterative paste/revise/save
  // workflow, not a one-shot submit.
  return NextResponse.json({ ok: true, analysis: up.data });
}
