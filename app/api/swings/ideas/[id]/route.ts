import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const ALLOWED_TIMEFRAMES = ["1month", "3months", "6months"] as const;
const ALLOWED_SENTIMENTS = ["bullish", "bearish", "mixed", "neutral"] as const;
const ALLOWED_STATUSES = ["watching", "conviction", "entered", "exited"] as const;

type UpdateBody = {
  symbol?: unknown;
  catalyst?: unknown;
  user_thesis?: unknown;
  timeframe?: unknown;
  conviction?: unknown;
  analyst_sentiment?: unknown;
  analyst_target?: unknown;
  price_at_discovery?: unknown;
  forward_pe?: unknown;
  status?: unknown;
};

function num(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.symbol !== undefined) {
    if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
      return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
    }
    patch.symbol = body.symbol.trim().toUpperCase();
  }
  if (body.catalyst !== undefined) {
    patch.catalyst = typeof body.catalyst === "string" ? body.catalyst : null;
  }
  if (body.user_thesis !== undefined) {
    patch.user_thesis = typeof body.user_thesis === "string" ? body.user_thesis : null;
  }
  if (body.timeframe !== undefined) {
    if (
      body.timeframe !== null &&
      (typeof body.timeframe !== "string" ||
        !(ALLOWED_TIMEFRAMES as readonly string[]).includes(body.timeframe))
    ) {
      return NextResponse.json({ error: "Invalid timeframe" }, { status: 400 });
    }
    patch.timeframe = body.timeframe;
  }
  if (body.conviction !== undefined) {
    const n = num(body.conviction);
    if (n === undefined) {
      /* unreachable */
    } else if (n === null) {
      patch.conviction = null;
    } else {
      const i = Math.round(n);
      if (i < 1 || i > 5) {
        return NextResponse.json({ error: "Conviction must be 1–5" }, { status: 400 });
      }
      patch.conviction = i;
    }
  }
  if (body.analyst_sentiment !== undefined) {
    if (
      body.analyst_sentiment !== null &&
      (typeof body.analyst_sentiment !== "string" ||
        !(ALLOWED_SENTIMENTS as readonly string[]).includes(body.analyst_sentiment))
    ) {
      return NextResponse.json({ error: "Invalid sentiment" }, { status: 400 });
    }
    patch.analyst_sentiment = body.analyst_sentiment;
  }
  if (body.analyst_target !== undefined) patch.analyst_target = num(body.analyst_target);
  if (body.price_at_discovery !== undefined)
    patch.price_at_discovery = num(body.price_at_discovery);
  if (body.forward_pe !== undefined) patch.forward_pe = num(body.forward_pe);
  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      !(ALLOWED_STATUSES as readonly string[]).includes(body.status)
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    patch.status = body.status;
  }

  const sb = createServerClient();
  const res = await sb.from("swing_ideas").update(patch).eq("id", id).select().single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ idea: res.data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const sb = createServerClient();
  const res = await sb.from("swing_ideas").delete().eq("id", id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
