// One-off correction, NOT part of the general backfill script.
//
// scripts/backfill-theme-rejection-scope.ts stamps unbackfilled rows
// with the theme's CURRENT theme_type/prompt — correct for every theme
// whose question never changed. But the SaaS theme's 32 rejections were
// all written in one ~13-second bulk-reject batch (see rejected_at
// timestamps) answering the ORIGINAL question — theme_type='supply_chain'
// ("who supplies CRM/NOW/SAP") — before the theme was switched to
// 'sector_comparable'. By the time the general backfill ran, the theme
// already read 'sector_comparable', so it stamped these 32 rows with
// the NEW question, which defeats the entire point of this feature:
// DDOG/SNOW/OKTA/ZS (rejected as "not suppliers," a supply_chain-only
// judgment) would still read as scope-matching and keep suppressing
// under sector_comparable. This script corrects those 32 rows to the
// question they were actually answering, per the user's own account of
// the incident (see the ticket this accompanies).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

const SAAS_THEME_ID = "d088bab4-cba8-41ec-b8ac-0d6a8760623a";
const ORIGINAL_THEME_TYPE = "supply_chain";

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { currentRejectionScope } = await import("../lib/theme-expansion");
  const sb = createServerClient();

  const themeRes = await sb
    .from<{ id: string; name: string; theme_type: string | null }>("themes")
    .select("id,name,theme_type")
    .eq("id", SAAS_THEME_ID)
    .maybeSingle();
  if (themeRes.error || !themeRes.data) {
    throw new Error(`SaaS theme not found: ${themeRes.error?.message ?? "no row"}`);
  }
  console.log(`Theme "${themeRes.data.name}" current theme_type=${themeRes.data.theme_type}`);

  // supply_chain has no per-theme expansion_prompt override on record
  // (the theme's expansion_prompt column is null, confirmed via direct
  // query before this script) — the original question was the
  // theme_type default template, unedited.
  const originalScope = currentRejectionScope(ORIGINAL_THEME_TYPE, null);
  console.log(
    `Re-stamping to theme_type=${originalScope.themeType} prompt_hash=${originalScope.promptHash.slice(0, 16)}…`,
  );

  type RejectionRow = { id: string; symbol: string };
  const before = await sb
    .from<RejectionRow>("theme_rejections")
    .select("id,symbol")
    .eq("theme_id", SAAS_THEME_ID);
  if (before.error) throw new Error(before.error.message);
  const beforeRows = (before.data ?? []) as unknown as RejectionRow[];
  console.log(`Rows before correction: ${beforeRows.length}`);

  const upd = await sb
    .from("theme_rejections")
    .update({ theme_type: originalScope.themeType, prompt_hash: originalScope.promptHash })
    .eq("theme_id", SAAS_THEME_ID);
  if (upd.error) throw new Error(`Update failed: ${upd.error.message}`);

  type StampedRow = { id: string; symbol: string; theme_type: string | null; prompt_hash: string | null };
  const after = await sb
    .from<StampedRow>("theme_rejections")
    .select("id,symbol,theme_type,prompt_hash")
    .eq("theme_id", SAAS_THEME_ID);
  if (after.error) throw new Error(after.error.message);
  const rows = (after.data ?? []) as unknown as StampedRow[];
  const correct = rows.filter(
    (r) => r.theme_type === originalScope.themeType && r.prompt_hash === originalScope.promptHash,
  );
  console.log(`Rows now stamped supply_chain: ${correct.length} / ${rows.length}`);
  console.log(`Symbols: ${rows.map((r) => r.symbol).sort().join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
