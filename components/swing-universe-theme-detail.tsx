"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Star, StarOff, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  is_active: boolean;
};

type Member = {
  id: string;
  symbol: string;
  is_anchor: boolean;
  source: string;
  added_at: string;
  is_active: boolean;
  notes: string | null;
  companyName: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  adr20Pct: number | null;
};

type SortKey =
  | "symbol"
  | "companyName"
  | "sector"
  | "marketCap"
  | "adr20Pct"
  | "price"
  | "is_anchor"
  | "source"
  | "added_at";

const SORT_VALUE: Record<SortKey, { get: (m: Member) => number | string | null; defaultDir: "asc" | "desc" }> = {
  symbol: { get: (m) => m.symbol, defaultDir: "asc" },
  companyName: { get: (m) => m.companyName ?? "", defaultDir: "asc" },
  sector: { get: (m) => m.sector ?? "", defaultDir: "asc" },
  marketCap: { get: (m) => m.marketCap, defaultDir: "desc" },
  adr20Pct: { get: (m) => m.adr20Pct, defaultDir: "desc" },
  price: { get: (m) => m.price, defaultDir: "desc" },
  is_anchor: { get: (m) => (m.is_anchor ? 1 : 0), defaultDir: "desc" },
  source: { get: (m) => m.source, defaultDir: "asc" },
  added_at: { get: (m) => m.added_at, defaultDir: "desc" },
};

function compareValues(a: number | string | null, b: number | string | null, dir: "asc" | "desc"): number {
  const mul = dir === "asc" ? 1 : -1;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return mul * String(a).localeCompare(String(b));
  }
  return mul * (a - b);
}

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtMarketCap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const isActive = sort.key === sortKey;
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th className={`px-2 py-1.5 text-${align}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 ${justify} ${isActive ? "text-foreground" : "hover:text-foreground"}`}
      >
        {label}
        {isActive && <span className="text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

export function SwingUniverseThemeDetail({ themeId }: { themeId: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "is_anchor", dir: "desc" });

  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{
    added: string[];
    reactivated: string[];
    alreadyActive: string[];
    invalid: string[];
  } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTheme(json.theme as Theme);
      setMembers(json.members as Member[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId]);

  function onSort(key: SortKey) {
    setSort((cur) => {
      if (cur.key !== key) return { key, dir: SORT_VALUE[key].defaultDir };
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  }

  const visible = useMemo(() => members.filter((m) => showInactive || m.is_active), [members, showInactive]);
  const sorted = useMemo(() => {
    const desc = SORT_VALUE[sort.key];
    return [...visible].sort((a, b) => {
      const primary = compareValues(desc.get(a), desc.get(b), sort.dir);
      if (primary !== 0) return primary;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [visible, sort]);

  async function patchMember(member: Member, patch: Partial<Pick<Member, "is_anchor" | "is_active">>) {
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, ...patch } : m)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update";
      setActionError(`Could not update ${member.symbol}: ${msg}`);
    }
  }

  async function addMembers() {
    const symbols = Array.from(
      new Set(
        addText
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0),
      ),
    );
    if (symbols.length === 0) return;
    setAdding(true);
    setAddResult(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAddResult(json);
      setAddText("");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add symbols";
      setActionError(msg);
    } finally {
      setAdding(false);
    }
  }

  if (loading && !theme) {
    return <div className="text-base text-muted-foreground">Loading theme…</div>;
  }
  if (error) {
    return <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">{error}</div>;
  }
  if (!theme) return null;

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/swings/universe"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Universe
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{theme.name}</h1>
        {theme.description && <p className="text-sm text-muted-foreground">{theme.description}</p>}
        {theme.theme_type && (
          <span className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {theme.theme_type}
          </span>
        )}
      </div>

      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-sm text-rose-200 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      <div className="rounded border border-border bg-background/40 p-3">
        <div className="mb-2 text-sm font-semibold text-foreground">Add symbols</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addMembers();
            }}
            placeholder="NVDA, AMD, or paste a list"
            className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-base uppercase"
          />
          <Button onClick={addMembers} disabled={adding || addText.trim().length === 0}>
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {addResult && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {addResult.added.length > 0 && (
              <span className="text-emerald-300">Added: {addResult.added.join(", ")}</span>
            )}
            {addResult.reactivated.length > 0 && (
              <span className="text-sky-300">Reactivated: {addResult.reactivated.join(", ")}</span>
            )}
            {addResult.alreadyActive.length > 0 && (
              <span>Already active: {addResult.alreadyActive.join(", ")}</span>
            )}
            {addResult.invalid.length > 0 && (
              <span className="text-rose-300">Invalid / no data: {addResult.invalid.join(", ")}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {visible.length} member{visible.length === 1 ? "" : "s"}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded border border-border/60 bg-background/30 px-3 py-6 text-center text-sm text-muted-foreground">
          No members yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortTh label="Symbol" sortKey="symbol" sort={sort} onSort={onSort} />
                <SortTh label="Company" sortKey="companyName" sort={sort} onSort={onSort} />
                <SortTh label="Sector" sortKey="sector" sort={sort} onSort={onSort} />
                <SortTh label="Mkt Cap" sortKey="marketCap" sort={sort} onSort={onSort} align="right" />
                <SortTh label="ADR%" sortKey="adr20Pct" sort={sort} onSort={onSort} align="right" />
                <SortTh label="Price" sortKey="price" sort={sort} onSort={onSort} align="right" />
                <SortTh label="Anchor" sortKey="is_anchor" sort={sort} onSort={onSort} align="center" />
                <SortTh label="Source" sortKey="source" sort={sort} onSort={onSort} />
                <SortTh label="Added" sortKey="added_at" sort={sort} onSort={onSort} />
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={m.id}
                  className={`border-b border-border/40 last:border-0 hover:bg-white/[0.02] ${
                    !m.is_active ? "opacity-50" : ""
                  }`}
                >
                  <td className="px-2 py-1.5 font-mono font-semibold text-foreground">{m.symbol}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{m.companyName ?? "—"}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{m.sector ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtMarketCap(m.marketCap)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtPct(m.adr20Pct)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(m.price)}</td>
                  <td className="px-2 py-1.5 text-center">
                    {m.is_anchor && (
                      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                        Anchor
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{m.source}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(m.added_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => patchMember(m, { is_anchor: !m.is_anchor })}
                        className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        title={m.is_anchor ? "Unset anchor" : "Set anchor"}
                        aria-label={m.is_anchor ? "Unset anchor" : "Set anchor"}
                      >
                        {m.is_anchor ? <StarOff className="h-3 w-3" /> : <Star className="h-3 w-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => patchMember(m, { is_active: !m.is_active })}
                        className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        title={m.is_active ? "Deactivate" : "Reactivate"}
                        aria-label={m.is_active ? "Deactivate member" : "Reactivate member"}
                      >
                        {m.is_active ? <Trash2 className="h-3 w-3" /> : <Undo2 className="h-3 w-3" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
