"use client";

// Reusable editable cell — used by both Tier 1 and Tier 2 grids. Click
// to edit, Enter / blur to commit, Escape to cancel. The amber border +
// pencil + "sys: X" hint kicks in whenever value diverges from system.

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
  width = "w-16",
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
          className={`${width} rounded border border-emerald-500/60 bg-background px-1 py-0.5 text-center font-mono text-xs`}
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
        <span className="mt-0.5 text-[9px] text-amber-300/70">sys: {sysDisplay}</span>
      ) : (
        <span className="mt-0.5 text-[9px] text-transparent select-none">.</span>
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
  if (!Number.isFinite(value)) return <span className="text-muted-foreground">—</span>;
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
    <span className="font-mono italic text-muted-foreground">{text}</span>
  );
}
