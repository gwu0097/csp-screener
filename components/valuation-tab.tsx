"use client";

// Phase 2 — Valuation tab. Editable bear/base/bull scenarios with live
// recomputation, debounced PATCH auto-save, version history dropdown,
// sensitivity grid, and weighted-target summary card.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, RefreshCw } from "lucide-react";
import {
  computeAllOutputs,
  type HistoricalRow,
  type ScenarioInputs,
  type ScenarioKey,
  type ScenarioSet,
  type ValuationModelOutput,
} from "@/lib/valuation";

type Version = {
  id: string;
  symbol: string;
  moduleType: string;
  output: ValuationModelOutput;
  runAt: string;
  expiresAt: string | null;
  isExpired: boolean;
  isCustomized: boolean;
};

const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  bear: "BEAR",
  base: "BASE",
  bull: "BULL",
};

const SCENARIO_PILL: Record<ScenarioKey, string> = {
  bear: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  base: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  bull: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
};

type Field = keyof ScenarioInputs;
const FIELD_ROWS: Array<{ key: Field; label: string; format: "pct" | "pe" }> = [
  { key: "rev_growth_y1", label: "Rev Growth Y1", format: "pct" },
  { key: "rev_growth_y2", label: "Rev Growth Y2", format: "pct" },
  { key: "rev_growth_y3", label: "Rev Growth Y3", format: "pct" },
  { key: "op_margin", label: "Op Margin", format: "pct" },
  { key: "exit_pe", label: "Exit P/E", format: "pe" },
  { key: "probability", label: "Probability", format: "pct" },
];

// ---------- Formatters ----------

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtSignedPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  const v = (n * 100).toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}
function fmtPE(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}
function fmtBigDollars(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
function fmtRoundPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n)}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function parseInputValue(raw: string, field: Field): number | null {
  const trimmed = raw.replace(/[%xX]/g, "").trim();
  if (trimmed === "" || trimmed === "-") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (field === "exit_pe") return n;
  // Percent fields — accept "5" or "0.05" interchangeably. Anything ≥ 1.5
  // (or ≤ -1.5 for negative growth) is read as a whole-number percent.
  if (Math.abs(n) >= 1.5) return n / 100;
  return n;
}
function formatInputValue(value: number, field: Field): string {
  if (field === "exit_pe") return value.toFixed(1);
  return (value * 100).toFixed(1);
}

// ---------- Tab entry ----------

export function ValuationTab({ symbol }: { symbol: string }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const selected =
    versions.find((v) => v.id === selectedId) ?? latest;
  const isLatest = selected?.id === latest?.id;

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
        <ModelView
          symbol={symbol}
          versions={versions}
          selected={selected as Version}
          onSelect={setSelectedId}
          onGenerate={generate}
          generating={generating}
          generationError={generationError}
          isLatest={isLatest}
          onPersist={(updated) =>
            setVersions((prev) =>
              prev.map((v) => (v.id === updated.id ? updated : v)),
            )
          }
        />
      )}
    </div>
  );
}

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
        bear/base/bull scenarios.
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

// ---------- Main view ----------

function ModelView({
  symbol,
  versions,
  selected,
  onSelect,
  onGenerate,
  generating,
  generationError,
  isLatest,
  onPersist,
}: {
  symbol: string;
  versions: Version[];
  selected: Version;
  onSelect: (id: string) => void;
  onGenerate: () => void;
  generating: boolean;
  generationError: string | null;
  isLatest: boolean;
  onPersist: (v: Version) => void;
}) {
  // Editable user inputs live here so live recomputation doesn't go
  // through the network. We re-seed on version change so flipping in the
  // dropdown shows the right numbers.
  const [userInputs, setUserInputs] = useState<ScenarioSet>(selected.output.user);
  const [savedState, setSavedState] = useState<"idle" | "saving" | "saved">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seedingRef = useRef(false);

  useEffect(() => {
    seedingRef.current = true;
    setUserInputs(selected.output.user);
    setSavedState("idle");
    // Allow the next user-driven change to trigger save again.
    queueMicrotask(() => {
      seedingRef.current = false;
    });
  }, [selected.id, selected.output.user]);

  const ctx = useMemo(
    () => ({
      last_revenue: selected.output.last_revenue,
      shares_outstanding: selected.output.shares_outstanding,
      tax_rate: selected.output.tax_rate,
      current_price: selected.output.current_price,
    }),
    [
      selected.output.last_revenue,
      selected.output.shares_outstanding,
      selected.output.tax_rate,
      selected.output.current_price,
    ],
  );

  const liveOutputs = useMemo(
    () => computeAllOutputs(userInputs, ctx),
    [userInputs, ctx],
  );

  const customized = useMemo(() => {
    const set = new Set<string>();
    for (const s of ["bear", "base", "bull"] as ScenarioKey[]) {
      for (const f of [
        "rev_growth_y1",
        "rev_growth_y2",
        "rev_growth_y3",
        "op_margin",
        "exit_pe",
        "probability",
      ] as Field[]) {
        if (Math.abs(userInputs[s][f] - selected.output.system[s][f]) > 1e-6) {
          set.add(`${s}.${f}`);
        }
      }
    }
    return set;
  }, [userInputs, selected.output.system]);

  const probSum =
    userInputs.bear.probability +
    userInputs.base.probability +
    userInputs.bull.probability;
  const probValid = Math.abs(probSum - 1) < 0.001;

  function setField(scenario: ScenarioKey, field: Field, value: number) {
    if (!isLatest) return;
    setUserInputs((prev) => ({
      ...prev,
      [scenario]: { ...prev[scenario], [field]: value },
    }));
  }

  // Debounced PATCH. We capture the latest userInputs each time the
  // setter fires; only the last debounce fire actually hits the network.
  useEffect(() => {
    if (!isLatest) return;
    if (seedingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSavedState("saving");
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/research/${encodeURIComponent(symbol)}/valuation`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: selected.id, user: userInputs }),
            cache: "no-store",
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { module: Version };
        onPersist(json.module);
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
  }, [userInputs, isLatest, selected.id]);

  return (
    <div className="space-y-4">
      <ModelHeader
        versions={versions}
        selected={selected}
        onSelect={onSelect}
        onGenerate={onGenerate}
        generating={generating}
        generationError={generationError}
        savedState={savedState}
        isLatest={isLatest}
      />

      <HistoricalTable rows={selected.output.historical} />

      <AssumptionsTable
        userInputs={userInputs}
        system={selected.output.system}
        customized={customized}
        editable={isLatest}
        onChange={setField}
        probValid={probValid}
        probSum={probSum}
      />

      <OutputsTable
        outputs={liveOutputs}
        systemOutputs={selected.output.system_outputs}
        showSystemRow={customized.size > 0}
      />

      <WeightedTargetCard
        outputs={liveOutputs}
        userInputs={userInputs}
        currentPrice={selected.output.current_price}
        systemOutputs={selected.output.system_outputs}
        showSystem={customized.size > 0}
        analystMean={selected.output.analyst_target_mean}
        analystHigh={selected.output.analyst_target_high}
        analystLow={selected.output.analyst_target_low}
        analystCount={selected.output.analyst_count}
      />

      <SensitivityTable
        baseEps={liveOutputs.base.eps_y3}
        basePE={userInputs.base.exit_pe}
        currentPrice={selected.output.current_price}
      />

      <VersionHistory
        versions={versions}
        selectedId={selected.id}
        onSelect={onSelect}
      />
    </div>
  );
}

// ---------- Header ----------

function ModelHeader({
  versions,
  selected,
  onSelect,
  onGenerate,
  generating,
  generationError,
  savedState,
  isLatest,
}: {
  versions: Version[];
  selected: Version;
  onSelect: (id: string) => void;
  onGenerate: () => void;
  generating: boolean;
  generationError: string | null;
  savedState: "idle" | "saving" | "saved";
  isLatest: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Last generated:</span>
        <span className="text-foreground">{fmtDate(selected.output.saved_at)}</span>
        <select
          value={selected.id}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {fmtDate(v.output.saved_at)}
              {v.output.customized_fields.length > 0 ? "  ✏️" : ""}
            </option>
          ))}
        </select>
        {!isLatest && (
          <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
            Read-only history
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {savedState === "saving" && (
          <span className="text-[10px] text-muted-foreground">Saving…</span>
        )}
        {savedState === "saved" && (
          <span className="text-[10px] text-emerald-300">Saved</span>
        )}
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
      </div>
      {generationError && (
        <div className="basis-full rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
          {generationError}
        </div>
      )}
    </div>
  );
}

// ---------- Historical financials ----------

function HistoricalTable({ rows }: { rows: HistoricalRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-border bg-background/40 p-3 text-muted-foreground">
        No historical financials available.
      </div>
    );
  }
  // Color: green if value improved over prior column, red if it dropped.
  const trendCls = (cur: number | null, prev: number | null): string => {
    if (cur === null || prev === null) return "";
    if (cur > prev) return "text-emerald-300";
    if (cur < prev) return "text-rose-300";
    return "";
  };

  return (
    <div>
      <SectionLabel>Historical financials (5y)</SectionLabel>
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
                  {r.revenue !== null ? fmtBigDollars(r.revenue) : "—"}
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
                    {r.rev_growth !== null ? fmtSignedPct(r.rev_growth) : "—"}
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
                    {r.op_margin !== null ? fmtPct(r.op_margin) : "—"}
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
                    {r.net_margin !== null ? fmtPct(r.net_margin) : "—"}
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

// ---------- Editable assumptions ----------

function AssumptionsTable({
  userInputs,
  system,
  customized,
  editable,
  onChange,
  probValid,
  probSum,
}: {
  userInputs: ScenarioSet;
  system: ScenarioSet;
  customized: Set<string>;
  editable: boolean;
  onChange: (s: ScenarioKey, f: Field, v: number) => void;
  probValid: boolean;
  probSum: number;
}) {
  return (
    <div>
      <SectionLabel>Projection assumptions</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {(["bear", "base", "bull"] as ScenarioKey[]).map((s) => (
                <th
                  key={s}
                  className="px-2 py-1 text-center font-medium uppercase text-muted-foreground"
                >
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCENARIO_PILL[s]}`}
                  >
                    {SCENARIO_LABEL[s]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIELD_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <td className="px-2 py-1 text-foreground">{row.label}</td>
                {(["bear", "base", "bull"] as ScenarioKey[]).map((s) => {
                  const fieldKey = `${s}.${row.key}`;
                  const isCustom = customized.has(fieldKey);
                  return (
                    <td key={s} className="px-2 py-1 text-center">
                      <EditableCell
                        value={userInputs[s][row.key]}
                        systemValue={system[s][row.key]}
                        field={row.key}
                        format={row.format}
                        editable={editable}
                        customized={isCustom}
                        onCommit={(v) => onChange(s, row.key, v)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!probValid && (
        <div className="mt-1 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[11px] text-rose-300">
          Probabilities must sum to 100% (currently {fmtPct(probSum, 1)}).
        </div>
      )}
    </div>
  );
}

function EditableCell({
  value,
  systemValue,
  field,
  format,
  editable,
  customized,
  onCommit,
}: {
  value: number;
  systemValue: number;
  field: Field;
  format: "pct" | "pe";
  editable: boolean;
  customized: boolean;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const display = format === "pct" ? fmtPct(value) : fmtPE(value);
  const sysDisplay = format === "pct" ? fmtPct(systemValue) : fmtPE(systemValue);

  function start() {
    if (!editable) return;
    setDraft(formatInputValue(value, field));
    setEditing(true);
  }

  function commit() {
    const parsed = parseInputValue(draft, field);
    if (parsed !== null && Number.isFinite(parsed)) onCommit(parsed);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  return (
    <div className="inline-flex flex-col items-center">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          className="w-16 rounded border border-emerald-500/60 bg-background px-1 py-0.5 text-center font-mono text-xs"
        />
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={!editable}
          title={
            customized
              ? `System: ${sysDisplay} · You: ${display}`
              : editable
                ? "Click to edit"
                : "Read-only"
          }
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs ${
            customized
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-border bg-background/40 text-foreground"
          } ${editable ? "hover:border-emerald-500/40 hover:bg-emerald-500/10" : "cursor-default opacity-80"}`}
        >
          {display}
          {customized && <Pencil className="h-2.5 w-2.5" />}
        </button>
      )}
      {customized ? (
        <span className="mt-0.5 text-[9px] text-amber-300/70">
          sys: {sysDisplay}
        </span>
      ) : (
        <span className="mt-0.5 text-[9px] text-transparent">.</span>
      )}
    </div>
  );
}

// ---------- Computed outputs ----------

function OutputsTable({
  outputs,
  systemOutputs,
  showSystemRow,
}: {
  outputs: ReturnType<typeof computeAllOutputs>;
  systemOutputs: ReturnType<typeof computeAllOutputs>;
  showSystemRow: boolean;
}) {
  const scenarios: ScenarioKey[] = ["bear", "base", "bull"];
  return (
    <div>
      <SectionLabel>Projected outputs (3-year)</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {scenarios.map((s) => (
                <th
                  key={s}
                  className="px-2 py-1 text-center font-medium uppercase text-muted-foreground"
                >
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCENARIO_PILL[s]}`}
                  >
                    {SCENARIO_LABEL[s]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Revenue Y3</td>
              {scenarios.map((s) => (
                <td key={s} className="px-2 py-1 text-center font-mono">
                  {fmtBigDollars(outputs[s].rev_y3)}
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">EPS Y3</td>
              {scenarios.map((s) => (
                <td key={s} className="px-2 py-1 text-center font-mono">
                  {fmtPrice(outputs[s].eps_y3)}
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Price Target</td>
              {scenarios.map((s) => (
                <td
                  key={s}
                  className="px-2 py-1 text-center font-mono font-semibold text-foreground"
                >
                  {fmtRoundPrice(outputs[s].price_target)}
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Return</td>
              {scenarios.map((s) => {
                const r = outputs[s].return_pct;
                const cls = r >= 0 ? "text-emerald-300" : "text-rose-300";
                return (
                  <td key={s} className={`px-2 py-1 text-center font-mono ${cls}`}>
                    {fmtSignedPct(r, 0)}
                  </td>
                );
              })}
            </tr>
            {showSystemRow && (
              <tr className="border-t border-border bg-amber-500/[0.04]">
                <td className="px-2 py-1 text-amber-300/80">System target</td>
                {scenarios.map((s) => (
                  <td
                    key={s}
                    className="px-2 py-1 text-center font-mono text-amber-200/90"
                  >
                    {fmtRoundPrice(systemOutputs[s].price_target)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Weighted target ----------

function WeightedTargetCard({
  outputs,
  userInputs,
  currentPrice,
  systemOutputs,
  showSystem,
  analystMean,
  analystHigh,
  analystLow,
  analystCount,
}: {
  outputs: ReturnType<typeof computeAllOutputs>;
  userInputs: ScenarioSet;
  currentPrice: number;
  systemOutputs: ReturnType<typeof computeAllOutputs>;
  showSystem: boolean;
  analystMean: number | null;
  analystHigh: number | null;
  analystLow: number | null;
  analystCount: number | null;
}) {
  const scenarios: ScenarioKey[] = ["bear", "base", "bull"];
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
        Weighted price target
      </div>
      <div className="mt-1 text-2xl font-bold text-foreground">
        {fmtRoundPrice(outputs.weighted_target)}{" "}
        <span
          className={`text-sm font-medium ${outputs.weighted_return_pct >= 0 ? "text-emerald-300" : "text-rose-300"}`}
        >
          ({fmtSignedPct(outputs.weighted_return_pct, 1)} from{" "}
          {fmtPrice(currentPrice)})
        </span>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
        {scenarios.map((s) => (
          <div key={s}>
            {SCENARIO_LABEL[s]} {fmtRoundPrice(outputs[s].price_target)} ×{" "}
            {fmtPct(userInputs[s].probability, 0)} ={" "}
            {fmtRoundPrice(outputs[s].price_target * userInputs[s].probability)}
          </div>
        ))}
      </div>
      {showSystem && (
        <div className="mt-2 text-[11px] text-amber-300/80">
          System weighted: {fmtRoundPrice(systemOutputs.weighted_target)}
        </div>
      )}
      {analystMean !== null && (
        <div className="mt-2 border-t border-emerald-500/20 pt-2 text-[11px] text-muted-foreground">
          Analyst consensus:{" "}
          <span className="text-foreground">{fmtRoundPrice(analystMean)}</span>
          {analystCount !== null && <> ({analystCount} analysts)</>}
          {analystLow !== null && analystHigh !== null && (
            <>
              {" "}
              · Range:{" "}
              <span className="text-foreground">
                {fmtRoundPrice(analystLow)} – {fmtRoundPrice(analystHigh)}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Sensitivity grid ----------

function SensitivityTable({
  baseEps,
  basePE,
  currentPrice,
}: {
  baseEps: number;
  basePE: number;
  currentPrice: number;
}) {
  if (!Number.isFinite(baseEps) || baseEps <= 0) return null;

  // Build EPS rows around the base case (-30% to +30%) and P/E columns
  // around the user's chosen base P/E.
  const epsRows = [
    baseEps * 0.6,
    baseEps * 0.8,
    baseEps,
    baseEps * 1.2,
    baseEps * 1.4,
  ];
  const peCols = [
    Math.max(8, basePE * 0.7),
    Math.max(10, basePE * 0.9),
    basePE,
    basePE * 1.15,
    basePE * 1.4,
  ];
  // Round P/E columns for cleaner headers.
  const peColsRounded = peCols.map((x) => Math.round(x));

  return (
    <div>
      <SectionLabel>
        Sensitivity: Price target by EPS × P/E
      </SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                EPS \\ P/E
              </th>
              {peColsRounded.map((pe, i) => (
                <th
                  key={i}
                  className="px-2 py-1 text-center font-medium text-muted-foreground"
                >
                  {pe}x
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {epsRows.map((eps, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-2 py-1 font-mono">${eps.toFixed(2)}</td>
                {peColsRounded.map((pe, j) => {
                  const target = eps * pe;
                  const isBaseCell = i === 2 && j === 2;
                  const cls = isBaseCell
                    ? "border border-emerald-500/60 bg-emerald-500/15 text-emerald-200 font-semibold"
                    : "";
                  return (
                    <td
                      key={j}
                      className={`px-2 py-1 text-center font-mono ${cls}`}
                    >
                      {fmtRoundPrice(target)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {currentPrice > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Current price: <span className="text-foreground">{fmtPrice(currentPrice)}</span>
        </div>
      )}
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
    <div>
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
            const baseTarget = v.output.outputs.base.price_target;
            const sysBase = v.output.system_outputs.base.price_target;
            const isCust = v.output.customized_fields.length > 0;
            const isSelected = v.id === selectedId;
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
                <div className="flex items-center gap-2">
                  <span className="text-foreground">
                    {fmtDate(v.output.saved_at)}
                  </span>
                  <span className="text-muted-foreground">
                    Base: {fmtRoundPrice(sysBase)}
                  </span>
                  {isCust ? (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <Pencil className="h-2.5 w-2.5" /> You:{" "}
                      {fmtRoundPrice(baseTarget)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Agreed with system
                    </span>
                  )}
                </div>
                {isCust && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {summarizeCustomization(v.output)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function summarizeCustomization(o: ValuationModelOutput): string {
  const ratio = o.outputs.weighted_target / o.system_outputs.weighted_target;
  if (ratio > 1.05) return "More bullish than system";
  if (ratio < 0.95) return "More bearish than system";
  return `${o.customized_fields.length} fields customized`;
}

// ---------- Tiny helpers ----------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
