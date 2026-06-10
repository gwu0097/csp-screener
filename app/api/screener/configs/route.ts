import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  listScreenerConfigs,
  sanitizeFilters,
} from "@/lib/screener-configs-db";
import type { ScreenerConfig } from "@/lib/screener-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET  → all configs (seeds the system presets on an empty table)
// POST → create a custom config

export async function GET() {
  const configs = await listScreenerConfigs();
  return NextResponse.json({ configs });
}

type Body = {
  name?: unknown;
  description?: unknown;
  filters?: unknown;
  notes?: unknown;
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "screener"
  );
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) {
    return NextResponse.json(
      { error: "Name is required (max 60 chars)" },
      { status: 400 },
    );
  }
  const filters = sanitizeFilters(body.filters);
  if (!filters) {
    return NextResponse.json(
      { error: "filters must be a map of { value, label } entries" },
      { status: 400 },
    );
  }
  const description =
    typeof body.description === "string" ? body.description.slice(0, 500) : "";
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 1000) : "";

  const sb = createServerClient();
  // Slug id from the name; suffix on collision so "My Screener" twice
  // yields my-screener and my-screener-2.
  const base = slugify(name);
  let id = base;
  for (let n = 2; n < 50; n += 1) {
    const existing = await sb
      .from("screener_configs")
      .select("id")
      .eq("id", id)
      .limit(1);
    if (existing.error) {
      return NextResponse.json(
        { error: existing.error.message },
        { status: 500 },
      );
    }
    if ((existing.data ?? []).length === 0) break;
    id = `${base}-${n}`;
  }

  const insert = await sb
    .from("screener_configs")
    .insert({
      id,
      name,
      description,
      filters,
      notes,
      is_system: false,
    })
    .select("*");
  if (insert.error) {
    return NextResponse.json({ error: insert.error.message }, { status: 500 });
  }
  const row = insert.data?.[0] as
    | { id: string; name: string; description: string; filters: ScreenerConfig["filters"]; notes: string; is_system: boolean }
    | undefined;
  return NextResponse.json({
    config: row
      ? {
          id: row.id,
          name: row.name,
          description: row.description ?? "",
          filters: row.filters,
          notes: row.notes ?? "",
          isSystem: row.is_system,
        }
      : { id, name, description, filters, notes, isSystem: false },
  });
}
