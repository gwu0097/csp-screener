"use client";

// Reusable editable cell — used by both Tier 1 and Tier 2 grids. Click
// to edit, Enter / blur to commit, Escape to cancel. The display state
// always shows a subtle border + pencil icon so it reads as an input
// box; hover brightens the border, edit-mode goes amber, customised
// values get an amber border and "sys: X" hint underneath.

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import {
  type CellKind,
  displayValue,
  formatInputValue,
  parseInputValue,
} from "@/components/valuation-format";

export function EditableCell({
  value,
  systemValue,
  kind,
  editable,
  onCommit,
  width = "w-20",
}: {
  value: number;
  systemValue: number;
  kind: CellKind;
  editable: boolean;
  onCommit: (v: number) => void;
  width?: string;
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

  const customized = Math.abs(value - systemValue) > 1e-6;
  const display = displayValue(value, kind);
  const sysDisplay = displayValue(systemValue, kind);

  function start() {
    if (!editable) return;
    setDraft(formatInputValue(value, kind));
    setEditing(true);
  }
  function commit() {
    const parsed = parseInputValue(draft, kind);
    if (parsed !== null && Number.isFinite(parsed)) onCommit(parsed);
    setEditing(false);
  }

  // Visual states:
  //   editing  → amber border, no pencil (cursor is in the input)
  //   custom   → amber border, amber bg, pencil filled-in
  //   default  → white/15 border + 5% bg + pencil at low opacity
  //   hover    → border brightens to white/35
  //   readonly → muted, no hover, no cursor
  const baseBtnCls = editable
    ? "cursor-text border-white/15 bg-white/[0.05] hover:border-white/40"
    : "cursor-default border-white/10 bg-white/[0.02] opacity-70";

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
            else if (e.key === "Escape") setEditing(false);
          }}
          className={`${width} rounded border border-amber-500 bg-background px-2 py-1 text-center font-mono text-xs outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30`}
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
          className={`${width} inline-flex items-center justify-between gap-1 rounded border px-2 py-1 font-mono text-xs transition-colors ${
            customized
              ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
              : `${baseBtnCls} text-foreground`
          }`}
        >
          <span className="flex-1 text-center">{display}</span>
          {editable && (
            <Pencil
              className={`h-2.5 w-2.5 flex-shrink-0 ${
                customized ? "text-amber-300" : "text-muted-foreground/50"
              }`}
            />
          )}
        </button>
      )}
      {customized ? (
        <span className="mt-0.5 text-[9px] text-amber-300/70">
          sys: {sysDisplay}
        </span>
      ) : (
        <span className="mt-0.5 select-none text-[9px] text-transparent">.</span>
      )}
    </div>
  );
}

export function CalcCell({
  value,
  format,
}: {
  value: number;
  format: "money" | "price" | "pct" | "signedPct" | "round";
}) {
  if (!Number.isFinite(value)) {
    return <span className="text-muted-foreground">—</span>;
  }
  let text: string;
  if (format === "money") {
    if (Math.abs(value) >= 1e12) text = `$${(value / 1e12).toFixed(2)}T`;
    else if (Math.abs(value) >= 1e9) text = `$${(value / 1e9).toFixed(2)}B`;
    else if (Math.abs(value) >= 1e6) text = `$${(value / 1e6).toFixed(1)}M`;
    else text = `$${value.toFixed(0)}`;
  } else if (format === "price") {
    text = `$${value.toFixed(2)}`;
  } else if (format === "round") {
    text = `$${Math.round(value)}`;
  } else if (format === "pct") {
    text = `${(value * 100).toFixed(1)}%`;
  } else {
    const v = (value * 100).toFixed(1);
    text = value >= 0 ? `+${v}%` : `${v}%`;
  }
  return (
    <span
      className="cursor-default font-mono italic text-muted-foreground/80"
      title="= calculated automatically"
    >
      {text}
    </span>
  );
}

// Small banner the projection / assumption tables render above
// themselves so users know which rows are editable.
export function CellLegend() {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex h-3.5 w-6 items-center justify-end rounded border border-white/15 bg-white/[0.05] pr-0.5">
          <Pencil className="h-2 w-2 text-muted-foreground/60" />
        </span>
        Click any bordered cell to edit
      </span>
      <span>·</span>
      <span>
        <span className="italic text-muted-foreground/80">Italicised rows</span>{" "}
        are calculated automatically
      </span>
    </div>
  );
}
