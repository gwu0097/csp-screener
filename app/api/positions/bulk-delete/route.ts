import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Bulk hard-delete by explicit id list. The "Remove all SYMBOL
// positions" button on the position card collects sibling ids from
// the parent (so the server doesn't have to re-query by symbol +
// status, avoiding any race with a concurrent import).

type Body = { ids?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "ids must be a non-empty string array" },
      { status: 400 },
    );
  }

  const sb = createServerClient();

  for (const table of [
    "fills",
    "position_snapshots",
    "post_earnings_recommendations",
  ]) {
    const r = await sb.from(table).delete().in("position_id", ids);
    if (r.error) {
      console.warn(
        `[positions/bulk-delete] child cleanup ${table} failed: ${r.error.message}`,
      );
    }
  }

  const del = await sb.from("positions").delete().in("id", ids);
  if (del.error) {
    return NextResponse.json({ error: del.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deletedCount: ids.length });
}
