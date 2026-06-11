import { NextResponse } from "next/server";
import { getUpcomingEarnings } from "@/lib/earnings";
import { isLikelyCommonEquity } from "@/lib/screener";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Morning-dashboard earnings feed: the next few days of BMO/AMC
// earnings (filtered to likely common equity so the lists aren't
// flooded with ETFs/funds/odd tickers — same gate the screener uses)
// plus the set of symbols already screened in today's saved run.

function easternToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function easternDateOf(ts: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const today = easternToday();

  const earningsRaw = await getUpcomingEarnings(3);
  const earnings = earningsRaw.filter((e) => isLikelyCommonEquity(e.symbol));

  // Symbols screened in today's most recent saved screener run. Used to
  // tag earnings rows with an "already screened" indicator. Best-effort
  // — a missing table / empty run just leaves the set empty.
  let screenedSymbols: string[] = [];
  try {
    const sb = createServerClient();
    const r = await sb
      .from("screener_results")
      .select("screened_at,candidates")
      .eq("user_id", userId)
      .order("screened_at", { ascending: false })
      .limit(1);
    const row = ((r.data ?? []) as Array<{
      screened_at: string | null;
      candidates: unknown;
    }>)[0];
    if (
      row?.screened_at &&
      easternDateOf(row.screened_at) === today &&
      Array.isArray(row.candidates)
    ) {
      screenedSymbols = Array.from(
        new Set(
          (row.candidates as Array<{ symbol?: string }>)
            .map((c) => (c.symbol ?? "").toUpperCase())
            .filter(Boolean),
        ),
      );
    }
  } catch (e) {
    console.warn(
      `[dashboard/earnings] screened-today lookup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  return NextResponse.json({ today, earnings, screenedSymbols });
}
