import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

const DEFAULT_MAX_RISK_PCT = 0.5;

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const res = await sb
    .from("swing_journal_settings")
    .select("max_risk_pct,portfolio_value")
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const row = res.data as { max_risk_pct: number; portfolio_value: number | null } | null;
  return NextResponse.json({
    max_risk_pct: row?.max_risk_pct ?? DEFAULT_MAX_RISK_PCT,
    portfolio_value: row?.portfolio_value ?? null,
  });
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function PATCH(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { max_risk_pct?: unknown; portfolio_value?: unknown };
  try {
    body = (await req.json()) as { max_risk_pct?: unknown; portfolio_value?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const maxRiskPct = num(body.max_risk_pct);
  const portfolioValue = num(body.portfolio_value);
  if (maxRiskPct !== null && maxRiskPct <= 0) {
    return NextResponse.json({ error: "max_risk_pct must be > 0" }, { status: 400 });
  }

  const sb = createServerClient();
  const res = await sb
    .from("swing_journal_settings")
    .upsert(
      {
        user_id: userId,
        ...(maxRiskPct !== null ? { max_risk_pct: maxRiskPct } : {}),
        ...(portfolioValue !== null ? { portfolio_value: portfolioValue } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ settings: res.data });
}
