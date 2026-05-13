// Apply the 13-row PST date correction identified in
// scripts/audit-pst-dates.ts. Targets are id-specific so re-run is
// safe — each update is gated on the row currently matching the
// "from" date (no-op if already at "to").
//
// Default: print only. Pass `--apply` to write.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}
const sb = createClient(url, key);

const APPLY = process.argv.includes("--apply");

type FillFix = { idPrefix: string; from: string; to: string; label: string };
const FILL_FIXES: FillFix[] = [
  { idPrefix: "f4d23cdf", from: "2026-05-13", to: "2026-05-12", label: "ASTS close 10@0.02" },
  { idPrefix: "d36f3d2e", from: "2026-05-12", to: "2026-05-13", label: "NVMI open 1@2" },
  { idPrefix: "5a299676", from: "2026-05-12", to: "2026-05-13", label: "NVMI open 1@2.9" },
  { idPrefix: "57dbbb79", from: "2026-05-12", to: "2026-05-13", label: "NVMI open 1@2.4" },
  { idPrefix: "31fc475a", from: "2026-05-12", to: "2026-05-13", label: "CSCO open 10@0.24" },
  { idPrefix: "97336b3f", from: "2026-05-12", to: "2026-05-13", label: "NVMI open 1@2.02" },
  { idPrefix: "9b2c3361", from: "2026-05-12", to: "2026-05-13", label: "NVMI close 1@2" },
  { idPrefix: "c6bcbec1", from: "2026-05-12", to: "2026-05-13", label: "ANET close 1@5.75" },
];

type PosFix = {
  idPrefix: string;
  field: "opened_date" | "closed_date";
  from: string;
  to: string;
  label: string;
};
const POSITION_FIXES: PosFix[] = [
  { idPrefix: "ef043c82", field: "closed_date", from: "2026-05-11", to: "2026-05-12", label: "SE $64" },
  { idPrefix: "ab06dc56", field: "closed_date", from: "2026-05-13", to: "2026-05-12", label: "ASTS $57" },
  { idPrefix: "b8fd11f8", field: "opened_date", from: "2026-05-12", to: "2026-05-13", label: "NVMI $400" },
  { idPrefix: "4a67764f", field: "opened_date", from: "2026-05-12", to: "2026-05-13", label: "NVMI $410" },
  { idPrefix: "a999ccb9", field: "opened_date", from: "2026-05-12", to: "2026-05-13", label: "CSCO $85" },
];

// UUID columns don't support LIKE in PostgREST; resolve prefixes
// in memory by fetching all candidate rows once.
let _fillIds: string[] | null = null;
async function allFillIds(): Promise<string[]> {
  if (_fillIds) return _fillIds;
  const r = await sb.from("fills").select("id");
  _fillIds = ((r.data ?? []) as Array<{ id: string }>).map((x) => x.id);
  return _fillIds;
}
let _posIds: string[] | null = null;
async function allPositionIds(): Promise<string[]> {
  if (_posIds) return _posIds;
  const r = await sb.from("positions").select("id");
  _posIds = ((r.data ?? []) as Array<{ id: string }>).map((x) => x.id);
  return _posIds;
}
async function resolveFillId(prefix: string): Promise<string | null> {
  const ids = await allFillIds();
  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`fill id prefix ${prefix} matched ${matches.length} rows — refusing`);
    return null;
  }
  return matches[0];
}
async function resolvePositionId(prefix: string): Promise<string | null> {
  const ids = await allPositionIds();
  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`position id prefix ${prefix} matched ${matches.length} rows — refusing`);
    return null;
  }
  return matches[0];
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes will happen)" : "DRY RUN (print only)"}\n`);

  console.log(`=== Fills (${FILL_FIXES.length}) ===`);
  const fillPlans: Array<{ id: string; before: string; to: string; label: string }> = [];
  for (const f of FILL_FIXES) {
    const fullId = await resolveFillId(f.idPrefix);
    if (!fullId) {
      console.log(`  ${f.idPrefix}…  ${f.label}  → could not resolve id`);
      continue;
    }
    const r = await sb
      .from("fills")
      .select("id,fill_date,fill_type,contracts,premium,created_at")
      .eq("id", fullId)
      .single();
    if (r.error || !r.data) {
      console.log(`  ${fullId.slice(0, 8)}…  ${f.label}  → fetch failed`);
      continue;
    }
    const stored = (r.data as { fill_date: string }).fill_date;
    if (stored === f.to) {
      console.log(`  ${fullId.slice(0, 8)}…  ${f.label}  → already at ${f.to} (no-op)`);
      continue;
    }
    if (stored !== f.from) {
      console.warn(
        `  ${fullId.slice(0, 8)}…  ${f.label}  → stored=${stored} but expected from=${f.from}; SKIP (manual review)`,
      );
      continue;
    }
    fillPlans.push({ id: fullId, before: stored, to: f.to, label: f.label });
    console.log(`  ${fullId.slice(0, 8)}…  ${f.label}  ${stored} → ${f.to}`);
  }

  console.log(`\n=== Position fields (${POSITION_FIXES.length}) ===`);
  const posPlans: Array<{
    id: string;
    field: "opened_date" | "closed_date";
    before: string;
    to: string;
    label: string;
  }> = [];
  for (const p of POSITION_FIXES) {
    const fullId = await resolvePositionId(p.idPrefix);
    if (!fullId) {
      console.log(`  ${p.idPrefix}…  ${p.label}  → could not resolve id`);
      continue;
    }
    const r = await sb
      .from("positions")
      .select(`id,${p.field},status,symbol,strike`)
      .eq("id", fullId)
      .single();
    if (r.error || !r.data) {
      console.log(`  ${fullId.slice(0, 8)}…  ${p.label}  → fetch failed`);
      continue;
    }
    const stored = (r.data as Record<string, string | null>)[p.field];
    if (stored === p.to) {
      console.log(`  ${fullId.slice(0, 8)}…  ${p.label} ${p.field}  → already at ${p.to} (no-op)`);
      continue;
    }
    if (stored !== p.from) {
      console.warn(
        `  ${fullId.slice(0, 8)}…  ${p.label} ${p.field}  → stored=${stored} but expected from=${p.from}; SKIP`,
      );
      continue;
    }
    posPlans.push({ id: fullId, field: p.field, before: stored, to: p.to, label: p.label });
    console.log(`  ${fullId.slice(0, 8)}…  ${p.label} ${p.field}  ${stored} → ${p.to}`);
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN. ${fillPlans.length} fills + ${posPlans.length} position fields ready to write. Re-run with --apply.`,
    );
    return;
  }

  console.log("\nApplying…");
  let okFills = 0;
  for (const fp of fillPlans) {
    const r = await sb.from("fills").update({ fill_date: fp.to }).eq("id", fp.id);
    if (r.error) {
      console.error(`fill ${fp.id} update failed: ${r.error.message}`);
      continue;
    }
    okFills += 1;
  }
  let okPos = 0;
  for (const pp of posPlans) {
    const patch: Record<string, string> = {};
    patch[pp.field] = pp.to;
    const r = await sb
      .from("positions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", pp.id);
    if (r.error) {
      console.error(`position ${pp.id} update failed: ${r.error.message}`);
      continue;
    }
    okPos += 1;
  }
  console.log(`\nApplied: ${okFills} fills + ${okPos} position fields.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
