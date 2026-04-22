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

type ParsedTrade = {
  symbol: string;
  action: "open" | "close";
  contracts: number;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  premium: number;
  broker: string;
};

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: (msg: string) => void;
};

const BROKERS = ["schwab", "robinhood", "fidelity", "other"] as const;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function ImportScreenshotModal({ open, onOpenChange, onSuccess }: Props) {
  const [broker, setBroker] = useState<string>("schwab");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [parsed, setParsed] = useState<ParsedTrade[] | null>(null);
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

  // Global paste — while the modal is open, Ctrl/Cmd+V anywhere grabs any
  // image on the clipboard. Skips if the user is pasting into a text field.
  useEffect(() => {
    if (!open) return;
    const handler = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const items = e.clipboardData?.items;
      if (!items) {
        console.log("[paste] no clipboard items");
        return;
      }
      console.log(`[paste] clipboard items count=${items.length}`);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        console.log(`[paste] item[${i}] kind=${it.kind} type=${it.type}`);
        if (it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            e.preventDefault();
            console.log(`[paste] image blob size=${blob.size} type=${blob.type}`);
            const url = await readAsDataUrl(blob);
            console.log(`[paste] dataUrl ready length=${url.length} prefix=${url.slice(0, 32)}`);
            setDataUrl(url);
            setParsed(null);
            setError(null);
            break;
          } else {
            console.warn(`[paste] item[${i}] is image but getAsFile returned null`);
          }
        }
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [open]);

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    console.log(`[upload] file name=${file.name} size=${file.size} type=${file.type}`);
    if (!file.type.startsWith("image/")) {
      setError("Not an image file");
      return;
    }
    const url = await readAsDataUrl(file);
    console.log(`[upload] dataUrl ready length=${url.length} prefix=${url.slice(0, 32)}`);
    setDataUrl(url);
    setParsed(null);
    setError(null);
  }

  async function parse() {
    if (!dataUrl) {
      console.warn("[parse] no dataUrl — cannot send");
      setError("No image captured. Paste or upload first.");
      return;
    }
    console.log(`[parse] sending image dataUrl length=${dataUrl.length}`);
    setParsing(true);
    setError(null);
    try {
      // Send the FULL data URL so the server can forward the real mime type
      // to Minimax. Minimax returns 400 if the declared mime doesn't match
      // the image bytes (e.g. JPEG-over-the-wire labeled as PNG).
      const res = await fetch("/api/trades/parse-screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl, broker }),
      });
      const json = (await res.json()) as { trades?: ParsedTrade[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setParsed(json.trades ?? []);
      if ((json.trades ?? []).length === 0) {
        setError("No trades detected — try a sharper image or a different broker view");
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
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trades: parsed }),
      });
      const json = (await res.json()) as {
        created?: number;
        matched?: number;
        unmatched?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const parts = [
        `Logged ${json.created ?? 0}`,
        (json.matched ?? 0) > 0 ? `matched ${json.matched}` : null,
        (json.unmatched ?? 0) > 0 ? `unmatched ${json.unmatched}` : null,
      ].filter(Boolean);
      onSuccess(parts.join(", "));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logging failed");
    } finally {
      setConfirming(false);
    }
  }

  function updateRow(idx: number, patch: Partial<ParsedTrade>) {
    setParsed((prev) => prev && prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }
  function removeRow(idx: number) {
    setParsed((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import from screenshot</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 text-sm">
          <label className="text-xs text-muted-foreground">Broker</label>
          <select
            value={broker}
            onChange={(e) => setBroker(e.target.value)}
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
            <div>Click, drag & drop, or paste (Ctrl/⌘+V) a broker screenshot</div>
            <div className="mt-1 text-xs">PNG / JPG</div>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </div>
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
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-2 py-1">Symbol</th>
                    <th className="px-2 py-1">Action</th>
                    <th className="px-2 py-1">Qty</th>
                    <th className="px-2 py-1">Strike</th>
                    <th className="px-2 py-1">Expiry</th>
                    <th className="px-2 py-1">Type</th>
                    <th className="px-2 py-1">Premium</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((t, idx) => (
                    <tr key={idx} className="border-t border-border">
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
                          onChange={(e) => updateRow(idx, { action: e.target.value as "open" | "close" })}
                          className="rounded border border-border bg-background px-1 py-0.5"
                        >
                          <option value="open">open</option>
                          <option value="close">close</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="1"
                          value={t.contracts}
                          onChange={(e) => updateRow(idx, { contracts: Math.max(1, Number(e.target.value) || 1) })}
                          className="w-14 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.5"
                          value={t.strike}
                          onChange={(e) => updateRow(idx, { strike: Number(e.target.value) })}
                          className="w-20 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          value={t.expiry}
                          onChange={(e) => updateRow(idx, { expiry: e.target.value })}
                          className="rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={t.optionType}
                          onChange={(e) => updateRow(idx, { optionType: e.target.value as "put" | "call" })}
                          className="rounded border border-border bg-background px-1 py-0.5"
                        >
                          <option value="put">put</option>
                          <option value="call">call</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.01"
                          value={t.premium}
                          onChange={(e) => updateRow(idx, { premium: Number(e.target.value) })}
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
                  Logging…
                </>
              ) : (
                `Confirm & log all (${parsed.length})`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
