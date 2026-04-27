"use client";

// Valuation tab orchestrator. Owns the version list and the active
// version's user inputs; dispatches to Tier 1 / Tier 2 / Comps
// subviews; debounces PATCH on every edit (2s).
//
// Version history shows both tier targets per saved row. Selecting an
// older version puts the UI in read-only mode — only the latest row is
// editable.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, RefreshCw } from "lucide-react";
import {
  isV2,
  type DCFScenarioInputs,
  type DCFScenarioSet,
  type ScenarioInputs,
  type ScenarioKey,
  type ScenarioSet,
  type ValuationModelV2,
} from "@/lib/valuation";
import { ValuationTier1 } from "@/components/valuation-tier1";
import { ValuationTier2 } from "@/components/valuation-tier2";
import { ValuationComps } from "@/components/valuation-comps";
import { fmtDate, fmtRoundPrice } from "@/components/valuation-format";

type Version = {
  id: string;
  symbol: string;
  moduleType: string;
  output: ValuationModelV2 | Record<string, unknown>;
  runAt: string;
  expiresAt: string | null;
  isExpired: boolean;
  isCustomized: boolean;
};

type Tier1Field = keyof ScenarioInputs;
type Tier2Field = keyof DCFScenarioInputs;

export function ValuationTab({ symbol }: { symbol: string }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"tier1" | "tier2">("tier1");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/valuation`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as { versions?: Version[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const list = json.versions ?? [];
      setVersions(list);
      if (list[0] && !selectedId) setSelectedId(list[0].id);
    } catch (e) {
      console.warn("[valuation] load failed:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function generate() {
    setGenerating(true);
    setGenerationError(null);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/valuation`,
        { method: "POST", cache: "no-store" },
      );
      const json = (await res.json()) as { module?: Version; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.module) {
        setVersions((prev) => [json.module as Version, ...prev]);
        setSelectedId(json.module.id);
      }
    } catch (e) {
      setGenerationError(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }

  const latest = versions[0] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? latest;
  const isLatest = selected?.id === latest?.id;
  const isV2Selected = selected ? isV2(selected.output) : false;

  return (
    <div className="rounded-md border border-border bg-background/30 p-3 text-xs">
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-6 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading valuation models…
        </div>
      ) : !latest ? (
        <EmptyState
          generating={generating}
          error={generationError}
          onGenerate={generate}
        />
      ) : (
        <>
          <Header
            versions={versions}
            selected={selected as Version}
            onSelect={setSelectedId}
            onGenerate={generate}
            generating={generating}
            generationError={generationError}
            isLatest={isLatest}
          />
          {!isV2Selected ? (
            <V1Notice
              version={selected as Version}
              onGenerate={generate}
              generating={generating}
            />
          ) : (
            <V2View
              symbol={symbol}
              version={selected as Version}
              isLatest={isLatest}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onPersist={(v) =>
                setVersions((prev) => prev.map((x) => (x.id === v.id ? v : x)))
              }
            />
          )}
          <VersionHistory
            versions={versions}
            selectedId={(selected as Version).id}
            onSelect={setSelectedId}
          />
        </>
      )}
    </div>
  );
}

// ---------- Empty state ----------

function EmptyState({
  generating,
  error,
  onGenerate,
}: {
  generating: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <div className="text-muted-foreground">
        Pulls 5 years of SEC EDGAR data and analyst estimates to build
        bear/base/bull scenarios for both a P/E Multiple model and a full
        DCF.
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating}
        className="inline-flex items-center gap-2 rounded border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
      >
        {generating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <span>📊</span>
        )}
        {generating ? "Generating…" : "Generate Valuation Model"}
      </button>
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------- v1 compatibility notice ----------

function V1Notice({
  version,
  onGenerate,
  generating,
}: {
  version: Version;
  onGenerate: () => void;
  generating: boolean;
}) {
  return (
    <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
      This is a legacy v1 model from{" "}
      {fmtDate((version.output as { saved_at?: string }).saved_at ?? version.runAt)}.
      Generate a new version to enable the upgraded P/E + DCF tiers and editing.
      <div className="mt-2">
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/20 px-2 py-1 text-xs hover:bg-amber-500/30 disabled:opacity-60"
        >
          {generating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Generate v2
        </button>
      </div>
    </div>
  );
}

// ---------- Header ----------

function Header({
  versions,
  selected,
  onSelect,
  onGenerate,
  generating,
  generationError,
  isLatest,
}: {
  versions: Version[];
  selected: Version;
  onSelect: (id: string) => void;
  onGenerate: () => void;
  generating: boolean;
  generationError: string | null;
  isLatest: boolean;
}) {
  const savedAt =
    (selected.output as { saved_at?: string }).saved_at ?? selected.runAt;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Last generated:</span>
        <span className="text-foreground">{fmtDate(savedAt)}</span>
        <select
          value={selected.id}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        >
          {versions.map((v) => {
            const sa = (v.output as { saved_at?: string }).saved_at ?? v.runAt;
            const cust = anyCustomized(v);
            return (
              <option key={v.id} value={v.id}>
                {fmtDate(sa)}
                {cust ? "  ✏️" : ""}
              </option>
            );
          })}
        </select>
        {!isLatest && (
          <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
            Read-only history
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating}
        className="inline-flex items-center gap-1 rounded border border-border bg-background/40 px-2 py-1 text-xs hover:bg-background/60 disabled:opacity-60"
      >
        {generating ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
        New Version
      </button>
      {generationError && (
        <div className="basis-full rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
          {generationError}
        </div>
      )}
    </div>
  );
}

function anyCustomized(v: Version): boolean {
  if (isV2(v.output)) {
    return (
      v.output.tier1.customized_fields.length > 0 ||
      v.output.tier2.customized_fields.length > 0
    );
  }
  const c = (v.output as { customized_fields?: string[] }).customized_fields ?? [];
  return c.length > 0;
}

// ---------- v2 view (tabs + tier dispatch + auto-save) ----------

function V2View({
  symbol,
  version,
  isLatest,
  activeTab,
  setActiveTab,
  onPersist,
}: {
  symbol: string;
  version: Version;
  isLatest: boolean;
  activeTab: "tier1" | "tier2";
  setActiveTab: (t: "tier1" | "tier2") => void;
  onPersist: (v: Version) => void;
}) {
  const model = version.output as ValuationModelV2;
  const [tier1User, setTier1User] = useState<ScenarioSet>(model.tier1.user);
  const [tier2User, setTier2User] = useState<DCFScenarioSet>(model.tier2.user);
  const [shares, setShares] = useState<number>(model.shares_outstanding);
  const [taxRate, setTaxRate] = useState<number>(model.tax_rate);
  const [savedState, setSavedState] = useState<"idle" | "saving" | "saved">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seedingRef = useRef(false);
  const dirtyRef = useRef<{
    tier1?: ScenarioSet;
    tier2?: DCFScenarioSet;
    shares_outstanding?: number;
    tax_rate?: number;
  }>({});

  // Re-seed when user picks a different version. We mark seedingRef so
  // the auto-save effect doesn't fire on the synthetic state change.
  useEffect(() => {
    seedingRef.current = true;
    setTier1User(model.tier1.user);
    setTier2User(model.tier2.user);
    setShares(model.shares_outstanding);
    setTaxRate(model.tax_rate);
    dirtyRef.current = {};
    setSavedState("idle");
    queueMicrotask(() => {
      seedingRef.current = false;
    });
  }, [version.id, model.tier1.user, model.tier2.user, model.shares_outstanding, model.tax_rate]);

  // The display model has live values for shares + tax rate so children
  // see edits before they're saved.
  const displayModel: ValuationModelV2 = useMemo(
    () => ({ ...model, shares_outstanding: shares, tax_rate: taxRate }),
    [model, shares, taxRate],
  );

  function setTier1Field(s: ScenarioKey, f: Tier1Field, v: number) {
    if (!isLatest) return;
    setTier1User((prev) => {
      const next = { ...prev, [s]: { ...prev[s], [f]: v } };
      dirtyRef.current.tier1 = next;
      return next;
    });
  }
  function setTier2Field(s: ScenarioKey, f: Tier2Field, v: number) {
    if (!isLatest) return;
    setTier2User((prev) => {
      const next = { ...prev, [s]: { ...prev[s], [f]: v } };
      dirtyRef.current.tier2 = next;
      return next;
    });
  }
  function setTier2Method(s: ScenarioKey, m: "gordon" | "exit_multiple") {
    if (!isLatest) return;
    setTier2User((prev) => {
      const next = { ...prev, [s]: { ...prev[s], terminal_method: m } };
      dirtyRef.current.tier2 = next;
      return next;
    });
  }
  function setSharesGlobal(rawShares: number) {
    if (!isLatest) return;
    setShares(rawShares);
    dirtyRef.current.shares_outstanding = rawShares;
  }
  function setTaxRateGlobal(rate: number) {
    if (!isLatest) return;
    setTaxRate(rate);
    dirtyRef.current.tax_rate = rate;
  }

  // Debounced PATCH. Whatever's dirty gets sent; the route recomputes
  // outputs and customized_fields server-side and we replace the
  // version with the response.
  useEffect(() => {
    if (!isLatest) return;
    if (seedingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (Object.keys(dirtyRef.current).length === 0) return;
    setSavedState("saving");
    debounceRef.current = setTimeout(async () => {
      const body: Record<string, unknown> = { id: version.id, ...dirtyRef.current };
      try {
        const res = await fetch(
          `/api/research/${encodeURIComponent(symbol)}/valuation`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { module: Version };
        onPersist(json.module);
        dirtyRef.current = {};
        setSavedState("saved");
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSavedState("idle"), 2000);
      } catch (e) {
        console.warn("[valuation] auto-save failed:", e);
        setSavedState("idle");
      }
    }, 2000);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier1User, tier2User, shares, taxRate, isLatest, version.id]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded border border-border bg-background/40 p-0.5">
          <TierTab
            label="P/E Multiple"
            active={activeTab === "tier1"}
            onClick={() => setActiveTab("tier1")}
          />
          <TierTab
            label="DCF Model"
            active={activeTab === "tier2"}
            onClick={() => setActiveTab("tier2")}
          />
        </div>
        <div className="text-[10px]">
          {savedState === "saving" && (
            <span className="text-muted-foreground">Saving…</span>
          )}
          {savedState === "saved" && (
            <span className="text-emerald-300">Saved</span>
          )}
        </div>
      </div>

      <HistoricalTable model={model} />

      {activeTab === "tier1" ? (
        <ValuationTier1
          model={displayModel}
          userInputs={tier1User}
          editable={isLatest}
          onChangeField={setTier1Field}
          onChangeShares={setSharesGlobal}
          onChangeTaxRate={setTaxRateGlobal}
        />
      ) : (
        <ValuationTier2
          model={displayModel}
          userInputs={tier2User}
          editable={isLatest}
          onChangeField={setTier2Field}
          onChangeTerminalMethod={setTier2Method}
        />
      )}

      <ValuationComps symbol={symbol} comps={model.comps} />
    </div>
  );
}

function TierTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

// ---------- Historical table (shared above both tiers) ----------

function HistoricalTable({ model }: { model: ValuationModelV2 }) {
  const rows = model.historical;
  if (rows.length === 0) return null;
  const trendCls = (cur: number | null, prev: number | null): string => {
    if (cur === null || prev === null) return "";
    if (cur > prev) return "text-emerald-300";
    if (cur < prev) return "text-rose-300";
    return "";
  };
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Historical financials (5y)
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                Metric
              </th>
              {rows.map((r) => (
                <th
                  key={r.year}
                  className="px-2 py-1 text-right font-medium text-muted-foreground"
                >
                  {r.year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Revenue</td>
              {rows.map((r) => (
                <td key={r.year} className="px-2 py-1 text-right font-mono">
                  {r.revenue !== null
                    ? `$${(r.revenue / 1e9).toFixed(2)}B`
                    : "—"}
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Rev Growth</td>
              {rows.map((r, i) => {
                const prev = i > 0 ? rows[i - 1].rev_growth : null;
                return (
                  <td
                    key={r.year}
                    className={`px-2 py-1 text-right font-mono ${trendCls(r.rev_growth, prev)}`}
                  >
                    {r.rev_growth !== null
                      ? `${(r.rev_growth * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                );
              })}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Op Margin</td>
              {rows.map((r, i) => {
                const prev = i > 0 ? rows[i - 1].op_margin : null;
                return (
                  <td
                    key={r.year}
                    className={`px-2 py-1 text-right font-mono ${trendCls(r.op_margin, prev)}`}
                  >
                    {r.op_margin !== null
                      ? `${(r.op_margin * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                );
              })}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Net Margin</td>
              {rows.map((r, i) => {
                const prev = i > 0 ? rows[i - 1].net_margin : null;
                return (
                  <td
                    key={r.year}
                    className={`px-2 py-1 text-right font-mono ${trendCls(r.net_margin, prev)}`}
                  >
                    {r.net_margin !== null
                      ? `${(r.net_margin * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                );
              })}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">EPS</td>
              {rows.map((r, i) => {
                const prev = i > 0 ? rows[i - 1].eps : null;
                return (
                  <td
                    key={r.year}
                    className={`px-2 py-1 text-right font-mono ${trendCls(r.eps, prev)}`}
                  >
                    {r.eps !== null ? `$${r.eps.toFixed(2)}` : "—"}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Version history ----------

function VersionHistory({
  versions,
  selectedId,
  onSelect,
}: {
  versions: Version[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (versions.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {expanded ? "Hide" : "Show"} version history ({versions.length}{" "}
        {versions.length === 1 ? "version" : "versions"})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 rounded border border-border bg-background/40 p-2">
          {versions.map((v) => {
            const isSelected = v.id === selectedId;
            const sa = (v.output as { saved_at?: string }).saved_at ?? v.runAt;
            const cust = anyCustomized(v);
            const v2 = isV2(v.output);
            const peTarget = v2
              ? (v.output as ValuationModelV2).tier1.outputs.base.price_target
              : (v.output as { outputs?: { base?: { price_target?: number } } })
                  .outputs?.base?.price_target ?? null;
            const dcfTarget = v2
              ? (v.output as ValuationModelV2).tier2.outputs.base.intrinsic_value
              : null;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelect(v.id)}
                className={`block w-full rounded border p-2 text-left text-[11px] ${
                  isSelected
                    ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                    : "border-border bg-background/40 hover:bg-background/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="text-foreground">{fmtDate(sa)}</span>
                  {peTarget !== null && (
                    <span className="text-muted-foreground">
                      P/E: Base {fmtRoundPrice(peTarget)}
                    </span>
                  )}
                  {dcfTarget !== null && (
                    <span className="text-muted-foreground">
                      DCF: Base {fmtRoundPrice(dcfTarget)}
                    </span>
                  )}
                  {!v2 && (
                    <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0.5 text-[9px] uppercase text-amber-300">
                      v1
                    </span>
                  )}
                  {cust && (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <Pencil className="h-2.5 w-2.5" /> customized
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
