import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Records each sub-query's yield for one fan-out run -- called once,
// client-side, after a "Run expansion" fan-out finishes (see
// components/swing-universe-theme-detail.tsx's runExpansion). Without
// this, a chronically unproductive angle is only visible for as long as
// that one run's in-memory report stays on screen.
export const maxDuration = 60;

type RunInput = {
  subQueryId?: unknown;
  subQueryName?: unknown;
  rawCount?: unknown;
  truncated?: unknown;
  crossDupCount?: unknown;
  queuedCount?: unknown;
  error?: unknown;
};

type Body = { runs?: unknown };

function isValidRun(v: unknown): v is RunInput {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.subQueryName === "string" && o.subQueryName.trim().length > 0;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const themeId = (params.id ?? "").trim();
  if (!themeId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.runs) || body.runs.length === 0) {
    return NextResponse.json({ error: "Missing runs array" }, { status: 400 });
  }
  const runs = body.runs.filter(isValidRun);
  if (runs.length === 0) {
    return NextResponse.json({ error: "No valid runs in request" }, { status: 400 });
  }

  const sb = createServerClient();
  const themeRes = await sb.from("themes").select("id").eq("id", themeId).eq("user_id", userId).maybeSingle();
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  if (!themeRes.data) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

  const rows = runs.map((r) => ({
    theme_id: themeId,
    subquery_id: typeof r.subQueryId === "string" && r.subQueryId.trim() ? r.subQueryId.trim() : null,
    subquery_name: (r.subQueryName as string).trim(),
    user_id: userId,
    raw_count: typeof r.rawCount === "number" && Number.isFinite(r.rawCount) ? r.rawCount : 0,
    truncated: typeof r.truncated === "boolean" ? r.truncated : false,
    cross_dup_count: typeof r.crossDupCount === "number" && Number.isFinite(r.crossDupCount) ? r.crossDupCount : 0,
    queued_count: typeof r.queuedCount === "number" && Number.isFinite(r.queuedCount) ? r.queuedCount : 0,
    error: typeof r.error === "string" && r.error.trim() ? r.error.trim() : null,
  }));

  const ins = await sb.from("theme_subquery_runs").insert(rows);
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  return NextResponse.json({ ok: true, inserted: rows.length });
}
