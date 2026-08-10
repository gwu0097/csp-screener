"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Theme = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  is_active: boolean;
  created_at: string;
  memberCount: number;
  anchorCount: number;
};

// theme_type stays a plain text column so future types can be added here
// without a migration — but the UI only offers a deliberate, guided choice
// since Phase C's expansion logic branches on this value.
const THEME_TYPES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "supply_chain",
    label: "Supply chain",
    description:
      "Members feed each other through a value chain. Expansion asks who supplies these companies and who supplies those suppliers. Example: AI Infrastructure (chips → memory → networking → power).",
  },
  {
    value: "sector_comparable",
    label: "Sector comparable",
    description:
      "Members share a customer or end market rather than supplying each other. Expansion asks who else competes for the same spend. Example: consumer retail (NKE, TGT, ELF).",
  },
  {
    value: "policy_driven",
    label: "Policy driven",
    description:
      "Members benefit or suffer from the same regulatory or government spending change. Expansion asks who else is exposed to that policy. Example: defense, infrastructure spending, tariffs.",
  },
  {
    value: "macro_sensitive",
    label: "Macro sensitive",
    description:
      "Members respond to the same macro variable — rates, oil, the dollar, housing starts. Expansion asks what else moves on that variable.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "No structured relationship; a list I maintain by hand. Expansion is manual only.",
  },
];
const DEFAULT_THEME_TYPE = "custom";

export function SwingUniverseView() {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Theme | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/swings/universe/themes", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setThemes(json.themes as Theme[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleArchive(theme: Theme) {
    setError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${theme.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !theme.is_active }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update";
      setError(`Could not update ${theme.name}: ${msg}`);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> New Theme
        </Button>
      </div>

      {loading && themes.length === 0 ? (
        <div className="text-base text-muted-foreground">Loading themes…</div>
      ) : themes.length === 0 ? (
        <div className="rounded border border-border bg-background/40 py-10 text-center text-sm text-muted-foreground">
          No themes yet. Create one to start curating a universe.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Members</th>
                <th className="px-3 py-2 text-right">Anchors</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {themes.map((t) => (
                <tr key={t.id} className="border-b border-border/40 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-3 py-2">
                    <Link href={`/swings/universe/${t.id}`} className="font-medium text-foreground hover:underline">
                      {t.name}
                    </Link>
                    {t.description && (
                      <div className="line-clamp-1 text-[11px] text-muted-foreground">{t.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{t.theme_type ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.memberCount}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.anchorCount}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                        t.is_active
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : "border-border bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      {t.is_active ? "Active" : "Archived"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(t)}
                        className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        title="Edit"
                        aria-label="Edit theme"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleArchive(t)}
                        className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        title={t.is_active ? "Archive" : "Reactivate"}
                        aria-label={t.is_active ? "Archive theme" : "Reactivate theme"}
                      >
                        {t.is_active ? <Archive className="h-3 w-3" /> : <ArchiveRestore className="h-3 w-3" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ThemeDialog open={createOpen} onOpenChange={setCreateOpen} theme={null} onSaved={load} />
      <ThemeDialog
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        theme={editing}
        onSaved={load}
      />
    </div>
  );
}

function ThemeDialog({
  open,
  onOpenChange,
  theme,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  theme: Theme | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [themeType, setThemeType] = useState(DEFAULT_THEME_TYPE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(theme?.name ?? "");
    setDescription(theme?.description ?? "");
    setThemeType(theme?.theme_type ?? DEFAULT_THEME_TYPE);
    setError(null);
  }, [open, theme]);

  // A theme edited outside this dialog (direct SQL, a future migration)
  // could carry a theme_type not in THEME_TYPES — surface it as its own
  // option instead of silently swapping it for "custom" on save.
  const selectOptions =
    theme?.theme_type && !THEME_TYPES.some((t) => t.value === theme.theme_type)
      ? [{ value: theme.theme_type, label: `${theme.theme_type} (existing)`, description: "" }, ...THEME_TYPES]
      : THEME_TYPES;
  const selectedType = selectOptions.find((t) => t.value === themeType) ?? null;

  async function submit() {
    if (name.trim().length === 0) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const url = theme ? `/api/swings/universe/themes/${theme.id}` : "/api/swings/universe/themes";
      const res = await fetch(url, {
        method: theme ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          theme_type: themeType.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{theme ? `Edit theme · ${theme.name}` : "New theme"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">{error}</div>}

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Name *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
              placeholder="AI Infrastructure"
              autoFocus
            />
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
              placeholder="What ties this group together"
            />
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Type</span>
            <select
              value={themeType}
              onChange={(e) => setThemeType(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
            >
              {selectOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {selectedType?.description && (
              <p className="text-[11px] text-muted-foreground">{selectedType.description}</p>
            )}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
