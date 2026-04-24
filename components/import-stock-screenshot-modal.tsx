"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, Trash2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ParsedStockTrade = {
  symbol: string;
  action: "buy" | "sell";
  shares: number;
  price: number;
  date: string;
  broker: string;
};

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: (msg: string) => void;
};

const BROKERS = ["schwab", "robinhood"] as const;

const BROKER_INSTRUCTIONS: Record<(typeof BROKERS)[number], string> = {
  schwab:
    "Screenshot your ThinkorSwim / Schwab Order History table. Parser pulls every FILLED stock row (ignores options and canceled orders).",
  robinhood:
    "Screenshot your Robinhood stock position card. Parser reads the Shares field and Average cost / Average sell price.",
};

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ImportStockScreenshotModal({ open, onOpenChange, onSuccess }: Props) {
  const [broker, setBroker] = useState<(typeof BROKERS)[number]>("schwab");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [parsed, setParsed] = useState<ParsedStockTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setDataUrl(null);
    setParsed(null);
    setError(null);
    setParsing(false);
    setConfirming(false);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Paste-from-clipboard while the modal is open.
  useEffect(() => {
    if (!open) return;
    const handler = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            e.preventDefault();
            const url = await readAsDataUrl(blob);
            setDataUrl(url);
            setParsed(null);
            setError(null);
            break;
          }
        }
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [open]);

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Not an image file");
      return;
    }
    const url = await readAsDataUrl(file);
    setDataUrl(url);
    setParsed(null);
    setError(null);
  }

  async function parse() {
    if (!dataUrl) {
      setError("No image captured. Paste or upload first.");
      return;
    }
    setParsing(true);
    setError(null);
    try {
      const res = await fetch("/api/trades/parse-screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl, broker, tradeType: "stock" }),
      });
      const json = (await res.json()) as {
        trades?: ParsedStockTrade[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const trades = (json.trades ?? []).map((t) => ({
        ...t,
        date: t.date && t.date.length >= 10 ? t.date : todayIso(),
      }));
      setParsed(trades);
      if (trades.length === 0) {
        setError("No stock trades detected — try a sharper image or switch broker.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Parse failed");
    } finally {
      setParsing(false);
    }
  }

  async function confirm() {
    if (!parsed || parsed.length === 0) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch("/api/swings/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trades: parsed, broker }),
      });
      const json = (await res.json()) as {
        inserted?: number;
        closed?: number;
        orphaned?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const parts = [
        (json.inserted ?? 0) > 0 ? `${json.inserted} opened` : null,
        (json.closed ?? 0) > 0 ? `${json.closed} closed` : null,
        (json.orphaned ?? 0) > 0 ? `${json.orphaned} orphaned sell` : null,
      ].filter(Boolean);
      const msg = parts.length > 0 ? parts.join(", ") : "Imported 0 trades";
      if (json.errors && json.errors.length > 0) {
        console.warn("[swing-import] row errors:", json.errors);
      }
      onSuccess(msg);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setConfirming(false);
    }
  }

  function updateRow(idx: number, patch: Partial<ParsedStockTrade>) {
    setParsed((prev) => prev && prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }
  function removeRow(idx: number) {
    setParsed((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import stock trades from screenshot</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 text-sm">
          <label className="text-xs text-muted-foreground">Broker</label>
          <select
            value={broker}
            onChange={(e) => setBroker(e.target.value as (typeof BROKERS)[number])}
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            {BROKERS.map((b) => (
              <option key={b} value={b}>
                {b[0].toUpperCase() + b.slice(1)}
              </option>
            ))}
          </select>
          {dataUrl && (
            <Button size="sm" variant="secondary" onClick={() => setDataUrl(null)}>
              <Trash2 className="mr-1 h-3 w-3" /> Clear image
            </Button>
          )}
        </div>

        {!dataUrl && (
          <>
            <div
              className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-border bg-background/40 px-4 py-10 text-center text-sm text-muted-foreground hover:bg-background/60"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                await onFile(f);
              }}
            >
              <Upload className="mb-2 h-8 w-8" />
              <div>Click, drag &amp; drop, or paste (Ctrl/⌘+V) a broker screenshot</div>
              <div className="mt-1 text-xs">PNG / JPG</div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {BROKER_INSTRUCTIONS[broker]}
            </div>
          </>
        )}

        {dataUrl && !parsed && (
          <div className="mt-3 space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={dataUrl}
              alt="screenshot preview"
              className="max-h-80 w-full rounded border border-border object-contain"
            />
            <Button onClick={parse} disabled={parsing} className="w-full">
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
              {parsing ? "Parsing…" : "Parse screenshot"}
            </Button>
          </div>
        )}

        {parsed && parsed.length > 0 && (
          <div className="mt-3 space-y-2 text-xs">
            <div className="text-sm text-muted-foreground">
              Found {parsed.length} trade{parsed.length === 1 ? "" : "s"} — review and confirm
            </div>
            <div className="max-h-96 overflow-auto rounded border border-border">
              <table className="w-full table-fixed">
                <colgroup>
                  <col style={{ width: "130px" }} />
                  <col style={{ width: "85px" }} />
                  <col style={{ width: "80px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "40px" }} />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-muted/40 text-left">
                  <tr>
                    <th className="whitespace-nowrap px-2 py-1">Date</th>
                    <th className="whitespace-nowrap px-2 py-1">Symbol</th>
                    <th className="whitespace-nowrap px-2 py-1">Action</th>
                    <th className="whitespace-nowrap px-2 py-1">Shares</th>
                    <th className="whitespace-nowrap px-2 py-1">Price</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((t, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          value={t.date}
                          onChange={(e) => updateRow(idx, { date: e.target.value })}
                          className="w-full rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={t.symbol}
                          onChange={(e) => updateRow(idx, { symbol: e.target.value.toUpperCase() })}
                          className="w-20 rounded border border-border bg-background px-1 py-0.5 uppercase"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={t.action}
                          onChange={(e) => updateRow(idx, { action: e.target.value as "buy" | "sell" })}
                          className="rounded border border-border bg-background px-1 py-0.5"
                        >
                          <option value="buy">buy</option>
                          <option value="sell">sell</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={t.shares}
                          onChange={(e) => updateRow(idx, { shares: Number(e.target.value) })}
                          className="w-20 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={t.price}
                          onChange={(e) => updateRow(idx, { price: Number(e.target.value) })}
                          className="w-20 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-rose-300"
                          onClick={() => removeRow(idx)}
                          aria-label="Remove"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={parsing || confirming}>
            Cancel
          </Button>
          {parsed && parsed.length > 0 && (
            <Button onClick={confirm} disabled={confirming}>
              {confirming ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing…
                </>
              ) : (
                `Confirm & import all (${parsed.length})`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
