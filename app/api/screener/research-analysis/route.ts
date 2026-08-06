import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

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

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
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

  const referenceStrike = asNullableNumber(body.referenceStrike, "referenceStrike");
  if (!referenceStrike.ok) return NextResponse.json({ error: referenceStrike.error }, { status: 400 });
  const spotAtAnalysis = asNullableNumber(body.spotAtAnalysis, "spotAtAnalysis");
  if (!spotAtAnalysis.ok) return NextResponse.json({ error: spotAtAnalysis.error }, { status: 400 });
  const emPctAtAnalysis = asNullableNumber(body.emPctAtAnalysis, "emPctAtAnalysis");
  if (!emPctAtAnalysis.ok) return NextResponse.json({ error: emPctAtAnalysis.error }, { status: 400 });
  const maxDownsideRatio = asNullableNumber(body.maxDownsideRatio, "maxDownsideRatio");
  if (!maxDownsideRatio.ok) return NextResponse.json({ error: maxDownsideRatio.error }, { status: 400 });

  const sb = createServerClient();
  const up = await sb
    .from("research_analyses")
    .upsert(
      {
        symbol,
        earnings_date: earningsDate,
        flags_fired: flagsFired.value,
        flags_na: flagsNa.value,
        flags_unknown: flagsUnknown.value,
        candidate_flags: candidateFlags.value,
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "symbol,earnings_date" },
    )
    .select()
    .single();
  if (up.error) {
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }
  // Returning the upserted row lets the paste-back UI rehydrate the
  // textarea from exactly what's now persisted, instead of clearing it
  // or re-fetching separately — this is an iterative paste/revise/save
  // workflow, not a one-shot submit.
  return NextResponse.json({ ok: true, analysis: up.data });
}
