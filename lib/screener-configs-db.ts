// DB access for named screener configs (screener_configs table).
// Server-only — keep Supabase out of client bundles; the client talks
// to /api/screener/configs instead.
import { createServerClient } from "@/lib/supabase";
import {
  CSP_EARNINGS_SCREENER,
  SYSTEM_SCREENER_PRESETS,
  type ScreenerConfig,
  type ScreenerConfigRow,
} from "@/lib/screener-config";

// Accept only well-formed {value, label} filter entries so a buggy
// client can't persist a shape the resolver chokes on.
export function sanitizeFilters(
  raw: unknown,
): ScreenerConfig["filters"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ScreenerConfig["filters"] = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) return null;
    if (!entry || typeof entry !== "object") return null;
    const { value, label } = entry as { value?: unknown; label?: unknown };
    const valueOk =
      typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string" || typeof value === "boolean";
    if (!valueOk || typeof label !== "string" || label.length > 200) {
      return null;
    }
    out[key] = { value: value as number | string | boolean, label };
  }
  return Object.keys(out).length > 0 ? out : null;
}

type DbRow = {
  id: string;
  name: string;
  description: string | null;
  filters: ScreenerConfig["filters"];
  notes: string | null;
  is_system: boolean;
};

function rowToConfig(row: DbRow): ScreenerConfigRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    filters: row.filters ?? {},
    notes: row.notes ?? "",
    isSystem: row.is_system,
  };
}

function presetRows(): ScreenerConfigRow[] {
  return SYSTEM_SCREENER_PRESETS.map((p) => ({ ...p, isSystem: true }));
}

// Upsert the system presets. Used to seed an empty table and to heal
// a missing preset (e.g. a row deleted by hand in the SQL editor).
async function seedSystemPresets(): Promise<void> {
  const sb = createServerClient();
  const { error } = await sb.from("screener_configs").upsert(
    SYSTEM_SCREENER_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      filters: p.filters,
      notes: p.notes,
      is_system: true,
    })),
    { onConflict: "id" },
  );
  if (error) {
    console.warn(`[screener-configs] seed failed — ${error.message}`);
  }
}

// All configs, system presets first then customs alphabetically.
// Seeds the presets when the table is empty; falls back to the
// in-memory presets when the table is missing or Supabase errors so
// the screener never loses its config source.
export async function listScreenerConfigs(): Promise<ScreenerConfigRow[]> {
  try {
    const sb = createServerClient();
    let r = await sb.from("screener_configs").select("*");
    if (r.error) {
      console.warn(`[screener-configs] list failed — ${r.error.message}`);
      return presetRows();
    }
    if ((r.data ?? []).length === 0) {
      await seedSystemPresets();
      r = await sb.from("screener_configs").select("*");
      if (r.error) return presetRows();
    }
    const rows = ((r.data ?? []) as DbRow[]).map(rowToConfig);
    rows.sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows.length > 0 ? rows : presetRows();
  } catch (e) {
    console.warn(
      `[screener-configs] list threw — ${e instanceof Error ? e.message : e}`,
    );
    return presetRows();
  }
}

export async function getScreenerConfigById(
  id: string,
): Promise<ScreenerConfigRow | null> {
  try {
    const sb = createServerClient();
    const r = await sb
      .from("screener_configs")
      .select("*")
      .eq("id", id)
      .limit(1);
    if (r.error || !r.data || r.data.length === 0) {
      // Heal: an unseeded table still resolves system preset ids.
      const preset = SYSTEM_SCREENER_PRESETS.find((p) => p.id === id);
      return preset ? { ...preset, isSystem: true } : null;
    }
    return rowToConfig(r.data[0] as DbRow);
  } catch {
    const preset = SYSTEM_SCREENER_PRESETS.find((p) => p.id === id);
    return preset ? { ...preset, isSystem: true } : null;
  }
}

// The config the screen route runs with: the requested id when it
// resolves, else the CSP Earnings default.
export async function getScreenerConfigOrDefault(
  id: string | null | undefined,
): Promise<ScreenerConfigRow> {
  if (id) {
    const cfg = await getScreenerConfigById(id);
    if (cfg) return cfg;
    console.warn(
      `[screener-configs] config "${id}" not found — falling back to default`,
    );
  }
  const def = await getScreenerConfigById(CSP_EARNINGS_SCREENER.id);
  return def ?? { ...CSP_EARNINGS_SCREENER, isSystem: true };
}
