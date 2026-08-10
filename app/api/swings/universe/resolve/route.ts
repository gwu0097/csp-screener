import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { resolveUniverseSymbols, type UniverseSelection } from "@/lib/universe";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase B — turns a selector's choice into the resolved,
// deduplicated symbol list. Called both for the live "N symbols selected"
// preview next to the selector and, again, at the start of a real run (so
// the run always reflects current theme membership rather than a possibly
// stale preview).

type Body = { includeIndex?: unknown; themeIds?: unknown; allThemes?: unknown };

function buildLabel(includeIndex: boolean, allThemes: boolean, themeNames: string[]): string {
  const parts: string[] = [];
  if (includeIndex) parts.push("S&P 500 + Nasdaq 100");
  if (allThemes) parts.push("All themes");
  else parts.push(...themeNames);
  return parts.length > 0 ? parts.join(" + ") : "None selected";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
  const selection: UniverseSelection = {
    includeIndex: typeof body.includeIndex === "boolean" ? body.includeIndex : true,
    themeIds: Array.isArray(body.themeIds)
      ? body.themeIds.filter((s): s is string => typeof s === "string")
      : [],
    allThemes: body.allThemes === true,
  };
  try {
    const resolved = await resolveUniverseSymbols(userId, selection);
    return NextResponse.json({
      symbols: resolved.symbols,
      count: resolved.symbols.length,
      themeNames: resolved.themeNames,
      label: buildLabel(selection.includeIndex, selection.allThemes, resolved.themeNames),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "resolve failed";
    console.error("[swings/universe/resolve] failed:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
