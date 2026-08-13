import { createServerClient } from "@/lib/supabase";
import type { ObservationClassification, ObservationResolutions } from "@/lib/observation-dictionary";

// Shared by app/api/screener/research-analysis/route.ts (the live save
// path) and scripts/backfill-candidate-observations.ts (the 2026-08-13
// dropped-observations backfill) so both write the dictionary/usages
// tables through the exact same logic — no hand-reimplementation.

// Inserts brand-new terms and, only where the caller explicitly chose to
// overwrite (resolutions.useNewDefinitionFor), updates a redefined term's
// stored definition. Reused terms (bare or matching) get no dictionary
// write here — use_count/last_used_at are handled entirely by
// syncObservationUsages below, recomputed from observation_usages rather
// than incremented, so a re-save of the same analysis never drifts.
export async function upsertDictionaryTerms(
  sb: ReturnType<typeof createServerClient>,
  classifications: ObservationClassification[],
  resolutions: ObservationResolutions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  for (const c of classifications) {
    if (c.status === "new_with_definition") {
      const kind = resolutions.newTermKinds[c.term];
      const insRes = await sb.from("observation_dictionary").insert({
        term: c.term,
        definition: c.definition,
        kind,
        use_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (insRes.error) return { ok: false, error: insRes.error.message };
    } else if (c.status === "existing_redefined" && resolutions.useNewDefinitionFor.includes(c.term)) {
      const updRes = await sb
        .from("observation_dictionary")
        .update({ definition: c.newDefinition, updated_at: nowIso })
        .eq("term", c.term);
      if (updRes.error) return { ok: false, error: updRes.error.message };
    }
  }
  return { ok: true };
}

// Reconciles observation_usages for (symbol, earningsDate) against the
// terms used in THIS save — a diff/sync, not an append, so re-saving the
// same analysis (the paste/revise/save loop this UI is built around)
// never double-counts. For every term whose usage set for this analysis
// changed (added or removed), use_count/first_used_at/last_used_at are
// recomputed from the full observation_usages table for that term, not
// incremented — a blind +1/-1 would drift on any partial-failure retry.
//
// usageCreatedAt backdates the inserted usage rows' created_at (which
// first_used_at/last_used_at are derived from) — the live save path
// omits it so new usages stamp "now"; the backfill script passes the
// original analysis's created_at so recovered historical usages don't
// all appear to have happened on the day of the backfill.
export async function syncObservationUsages(
  sb: ReturnType<typeof createServerClient>,
  symbol: string,
  earningsDate: string,
  newTerms: string[],
  usageCreatedAt?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existingRes = await sb
    .from("observation_usages")
    .select("term")
    .eq("symbol", symbol)
    .eq("earnings_date", earningsDate);
  if (existingRes.error) return { ok: false, error: existingRes.error.message };
  const existingTerms = new Set(((existingRes.data ?? []) as { term: string }[]).map((r) => r.term));
  const newTermSet = new Set(newTerms);

  const toDelete = Array.from(existingTerms).filter((t) => !newTermSet.has(t));
  const toInsert = Array.from(newTermSet).filter((t) => !existingTerms.has(t));

  for (const term of toDelete) {
    const delRes = await sb
      .from("observation_usages")
      .delete()
      .eq("term", term)
      .eq("symbol", symbol)
      .eq("earnings_date", earningsDate);
    if (delRes.error) return { ok: false, error: delRes.error.message };
  }

  if (toInsert.length > 0) {
    const insRes = await sb.from("observation_usages").insert(
      toInsert.map((term) => ({
        term,
        symbol,
        earnings_date: earningsDate,
        ...(usageCreatedAt ? { created_at: usageCreatedAt } : {}),
      })),
    );
    if (insRes.error) return { ok: false, error: insRes.error.message };
  }

  const affected = Array.from(new Set([...toDelete, ...toInsert]));
  for (const term of affected) {
    const usagesRes = await sb.from("observation_usages").select("created_at").eq("term", term);
    if (usagesRes.error) return { ok: false, error: usagesRes.error.message };
    const rows = (usagesRes.data ?? []) as { created_at: string }[];
    const times = rows.map((r) => new Date(r.created_at).getTime()).filter((t) => !Number.isNaN(t));
    const updRes = await sb
      .from("observation_dictionary")
      .update({
        use_count: rows.length,
        first_used_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        last_used_at: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("term", term);
    if (updRes.error) return { ok: false, error: updRes.error.message };
  }

  return { ok: true };
}
