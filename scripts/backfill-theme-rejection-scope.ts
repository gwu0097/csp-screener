// One-time backfill: existing theme_rejections rows predate the
// theme_type/prompt_hash columns (see migrations/2026-08-10-scope-
// theme-rejections.sql). Stamps each unbackfilled row (theme_type IS
// NULL) with its theme's CURRENT theme_type/expansion_prompt — a
// reasonable one-time assumption since these rows were written before
// the theme's question ever changed (this feature didn't exist yet to
// let a stale rejection survive a change). Never deletes anything; only
// ever sets theme_type/prompt_hash where they're still null, so it's
// safe to re-run (already-stamped rows are skipped).
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

type ThemeRow = { id: string; name: string; theme_type: string | null; expansion_prompt: string | null };
type RejectionIdRow = { id: string };

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { currentRejectionScope } = await import("../lib/theme-expansion");
  const sb = createServerClient();

  const themesRes = await sb.from<ThemeRow>("themes").select("id,name,theme_type,expansion_prompt");
  if (themesRes.error || !themesRes.data) {
    throw new Error(`Failed to load themes: ${themesRes.error?.message ?? "no data"}`);
  }
  const themes = themesRes.data as unknown as ThemeRow[];
  console.log(`Loaded ${themes.length} theme(s).`);

  let totalStamped = 0;
  for (const theme of themes) {
    const scope = currentRejectionScope(theme.theme_type, theme.expansion_prompt);

    const unstamped = await sb
      .from<RejectionIdRow>("theme_rejections")
      .select("id")
      .eq("theme_id", theme.id)
      .is("theme_type", null);
    if (unstamped.error) {
      console.error(`  [${theme.name}] failed to read unstamped rows: ${unstamped.error.message}`);
      continue;
    }
    const count = ((unstamped.data ?? []) as unknown as RejectionIdRow[]).length;
    if (count === 0) {
      console.log(`  [${theme.name}] 0 rows to stamp`);
      continue;
    }

    const upd = await sb
      .from("theme_rejections")
      .update({ theme_type: scope.themeType, prompt_hash: scope.promptHash })
      .eq("theme_id", theme.id)
      .is("theme_type", null);
    if (upd.error) {
      console.error(`  [${theme.name}] update failed: ${upd.error.message}`);
      continue;
    }
    totalStamped += count;
    console.log(
      `  [${theme.name}] stamped ${count} row(s) — theme_type=${scope.themeType ?? "(null)"} prompt_hash=${scope.promptHash.slice(0, 12)}…`,
    );
  }

  console.log(`\nTotal rows stamped: ${totalStamped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
