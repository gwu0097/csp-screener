import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  getScreenerConfigById,
  sanitizeFilters,
} from "@/lib/screener-configs-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// PUT    → update a custom config (system presets are read-only)
// DELETE → delete a custom config (system presets are non-deletable)

type Params = { params: { id: string } };

export async function PUT(req: NextRequest, { params }: Params) {
  const id = params.id;
  const existing = await getScreenerConfigById(id);
  if (!existing) {
    return NextResponse.json({ error: "Config not found" }, { status: 404 });
  }
  if (existing.isSystem) {
    return NextResponse.json(
      { error: "System presets are read-only — clone it via Save current as…" },
      { status: 403 },
    );
  }

  let body: {
    name?: unknown;
    description?: unknown;
    filters?: unknown;
    notes?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) {
      return NextResponse.json(
        { error: "Name is required (max 60 chars)" },
        { status: 400 },
      );
    }
    patch.name = name;
  }
  if (body.filters !== undefined) {
    const filters = sanitizeFilters(body.filters);
    if (!filters) {
      return NextResponse.json(
        { error: "filters must be a map of { value, label } entries" },
        { status: 400 },
      );
    }
    patch.filters = filters;
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.slice(0, 500) : "";
  }
  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.slice(0, 1000) : "";
  }

  const sb = createServerClient();
  const upd = await sb
    .from("screener_configs")
    .update(patch)
    .eq("id", id)
    .eq("is_system", false)
    .select("*");
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 });
  }
  const row = upd.data?.[0];
  if (!row) {
    return NextResponse.json({ error: "Config not found" }, { status: 404 });
  }
  return NextResponse.json({
    config: {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      filters: row.filters,
      notes: row.notes ?? "",
      isSystem: row.is_system,
    },
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = params.id;
  const existing = await getScreenerConfigById(id);
  if (!existing) {
    return NextResponse.json({ error: "Config not found" }, { status: 404 });
  }
  if (existing.isSystem) {
    return NextResponse.json(
      { error: "System presets cannot be deleted" },
      { status: 403 },
    );
  }
  const sb = createServerClient();
  const del = await sb
    .from("screener_configs")
    .delete()
    .eq("id", id)
    .eq("is_system", false);
  if (del.error) {
    return NextResponse.json({ error: del.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
