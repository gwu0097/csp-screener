import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { recalculatePositionFromFills } from "@/lib/positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Add a single fill to an existing position. Mirrors the per-fill
// path inside /api/trades/bulk-create — same insert columns, same
// recalc-from-full-fills helper. Used by the position-card "Edit
// Fills" panel.
type Body = {
  side?: unknown;
  contracts?: unknown;
  premium?: unknown;
  fill_date?: unknown;
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const positionId = params.id;
  if (!positionId) {
    return NextResponse.json({ error: "Missing position id" }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sideRaw = typeof body.side === "string" ? body.side.toLowerCase() : "";
  const fill_type: "open" | "close" =
    sideRaw === "close" || sideRaw === "buy" ? "close" : "open";
  const contracts = Number(body.contracts);
  const premium = Number(body.premium);
  const fill_date =
    typeof body.fill_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.fill_date)
      ? body.fill_date
      : new Date().toISOString().slice(0, 10);

  if (!Number.isFinite(contracts) || contracts <= 0) {
    return NextResponse.json({ error: "contracts must be > 0" }, { status: 400 });
  }
  if (!Number.isFinite(premium) || premium < 0) {
    return NextResponse.json({ error: "premium must be ≥ 0" }, { status: 400 });
  }

  const sb = createServerClient();
  // Sanity check: position must exist before we attach a fill to it.
  const pos = await sb.from("positions").select("id").eq("id", positionId);
  if (pos.error) {
    return NextResponse.json({ error: pos.error.message }, { status: 500 });
  }
  if (!pos.data || (pos.data as Array<{ id: string }>).length === 0) {
    return NextResponse.json({ error: "Position not found" }, { status: 404 });
  }

  const ins = await sb.from("fills").insert({
    position_id: positionId,
    fill_type,
    contracts,
    premium,
    fill_date,
  });
  if (ins.error) {
    return NextResponse.json(
      { error: `fill insert failed — ${ins.error.message}` },
      { status: 500 },
    );
  }

  const recalc = await recalculatePositionFromFills(positionId, sb);
  if (!recalc.ok) {
    return NextResponse.json({ error: recalc.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: recalc.status });
}
