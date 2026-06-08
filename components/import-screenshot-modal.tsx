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
  // Actual trade date from the ToS "Time Placed" column. When the parser
  // can't recover it we default to today so the review table always has a
  // concrete date to show and edit.
  timePlaced?: string; // YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  // Preview-only marker — two rows sharing a spread_group are the two
  // legs of one order (CALENDAR roll, DIAGONAL, vertical, etc.). The
  // table renders a small "ROLL" / "SPREAD" badge to make the link
  // visible. Not sent to bulk-create (ignored server-side).
  spread_group?: string;
};

type ParsedStockTrade = {
  symbol: string;
  action: "buy" | "sell";
  shares: number;
  price: number;
  date: string;
  broker: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: (msg: string) => void;
};

const TIMEZONES = [
  { value: "ET", label: "ET — Eastern Time" },
  { value: "PT", label: "PT — Pacific Time" },
  { value: "HK", label: "HK — Hong Kong" },
  { value: "CN", label: "CN — China / Shanghai" },
  { value: "JP", label: "JP — Japan" },
  { value: "UTC", label: "UTC" },
] as const;
const LS_TIMEZONE_KEY = "import_timezone";

const BROKERS = ["schwab", "schwab2", "robinhood"] as const;
const BROKER_LABELS: Record<(typeof BROKERS)[number], string> = {
  schwab: "Schwab",
  schwab2: "Schwab 2",
  robinhood: "Robinhood",
};

// Short per-broker help — rendered beneath the upload dropzone so users
// know what the parser expects for the selected broker.
const BROKER_INSTRUCTIONS: Record<(typeof BROKERS)[number], string> = {
  schwab:
    "Screenshot your ThinkorSwim / Schwab Order History table. Parser pulls every FILLED row.",
  schwab2:
    "Same parser as Schwab — uses ThinkorSwim / Schwab Order History layout. Imports tag the secondary Schwab account.",
  robinhood:
    "Screenshot your Robinhood position detail cards. Scroll to capture multiple open positions in one image — each card becomes its own fill.",
};

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
  // Source timezone of the screenshot — drives ET-date conversion
  // server-side in bulk-create. Default ET so US-domestic users
  // don't need to interact. Persisted in localStorage so a HK
  // user only sets it once per browser.
  const [timezone, setTimezone] = useState<string>("PT");
  // Refresh from localStorage every time the modal opens — not just
  // on first mount. Some Dialog implementations keep state across
  // closes, and we also want the latest value if the user changed it
  // in another tab/window between opens. Runs client-side only since
  // useEffect doesn't fire during SSR / server render.
  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem(LS_TIMEZONE_KEY);
      if (stored && TIMEZONES.some((t) => t.value === stored)) {
        setTimezone(stored);
      }
    } catch {
      /* ignore — localStorage unavailable (private mode, etc.) */
    }
  }, [open]);
  function pickTimezone(tz: string) {
    setTimezone(tz);
    try {
      localStorage.setItem(LS_TIMEZONE_KEY, tz);
    } catch {
      /* ignore */
    }
  }
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [parsed, setParsed] = useState<ParsedTrade[] | null>(null);
  const [parsedStocks, setParsedStocks] = useState<ParsedStockTrade[] | null>(null);
  const [rejections, setRejections] = useState<Array<{ symbol: string; reason: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  // Populated alongside `error` when the bulk-create route returns
  // 422 with structured per-row errors. The render path turns each
  // entry into a bullet so the user sees which trade(s) need fixing.
  const [errorList, setErrorList] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setDataUrl(null);
    setParsed(null);
    setParsedStocks(null);
    setRejections([]);
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
    setParsedStocks(null);
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
    setParsedStocks(null);
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
      const json = (await res.json()) as {
        trades?: ParsedTrade[];
        stockTrades?: ParsedStockTrade[];
        rejections?: Array<{ symbol: string; reason: string }>;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const trades = (json.trades ?? []).map((t) => ({
        ...t,
        timePlaced: t.timePlaced && t.timePlaced.length >= 10 ? t.timePlaced : todayIso(),
      }));
      const stocks = (json.stockTrades ?? []).map((s) => ({
        ...s,
        date: s.date && s.date.length >= 10 ? s.date : todayIso(),
      }));
      setParsed(trades);
      setParsedStocks(stocks);
      const rej = json.rejections ?? [];
      setRejections(rej);
      if (trades.length === 0 && stocks.length === 0 && rej.length === 0) {
        setError("No trades detected — try a sharper image or a different broker view");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Parse failed");
    } finally {
      setParsing(false);
    }
  }

  async function confirm() {
    const optionCount = parsed?.length ?? 0;
    const stockCount = parsedStocks?.length ?? 0;
    if (optionCount === 0 && stockCount === 0) return;
    setConfirming(true);
    setError(null);
    setErrorList([]);
    try {
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trades: parsed ?? [],
          stockTrades: parsedStocks ?? [],
          sourceTimezone: timezone,
        }),
      });
      const json = (await res.json()) as {
        positions_created?: number;
        positions_updated?: number;
        fills_inserted?: number;
        stocks_closed?: number;
        stocks_partial?: number;
        errors?: string[];
        error?: string;
      };
      // Phase 1 (422) returns { errors: [...] } — surface every row's
      // reason so the user can fix the screenshot before retrying. Only
      // fall back to a generic "HTTP N" when the body carries no
      // structured error info.
      if (json.errors && json.errors.length > 0) {
        setErrorList(json.errors);
        setError(
          `${json.errors.length} trade${json.errors.length === 1 ? "" : "s"} failed validation`,
        );
        setConfirming(false);
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const parts = [
        (json.fills_inserted ?? 0) > 0
          ? `Logged ${json.fills_inserted} fill${(json.fills_inserted ?? 0) === 1 ? "" : "s"}`
          : null,
        (json.positions_created ?? 0) > 0
          ? `${json.positions_created} new position${json.positions_created === 1 ? "" : "s"}`
          : null,
        (json.positions_updated ?? 0) > 0
          ? `${json.positions_updated} updated`
          : null,
        (json.stocks_closed ?? 0) > 0
          ? `${json.stocks_closed} stock position${json.stocks_closed === 1 ? "" : "s"} closed`
          : null,
        (json.stocks_partial ?? 0) > 0
          ? `${json.stocks_partial} stock partial sale${json.stocks_partial === 1 ? "" : "s"}`
          : null,
      ].filter(Boolean);
      onSuccess(parts.join(", ") || "Import complete");
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
  function updateStockRow(idx: number, patch: Partial<ParsedStockTrade>) {
    setParsedStocks((prev) =>
      prev && prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  }
  function removeStockRow(idx: number) {
    setParsedStocks((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import from screenshot</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 text-base">
          <label className="text-sm text-muted-foreground">Broker</label>
          <select
            value={broker}
            onChange={(e) => setBroker(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            {BROKERS.map((b) => (
              <option key={b} value={b}>
                {BROKER_LABELS[b]}
              </option>
            ))}
          </select>
          <label className="text-sm text-muted-foreground">Timezone</label>
          <select
            value={timezone}
            onChange={(e) => pickTimezone(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
            title="Timezone the broker screenshot was displayed in. Server converts to ET before storing dates."
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
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
              className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-border bg-background/40 px-4 py-10 text-center text-base text-muted-foreground hover:bg-background/60"
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
              <div className="mt-1 text-sm">PNG / JPG</div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              {BROKER_INSTRUCTIONS[broker as (typeof BROKERS)[number]] ??
                BROKER_INSTRUCTIONS.schwab}
            </div>
          </>
        )}

        {dataUrl && parsed === null && parsedStocks === null && (
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
          <div className="mt-3 space-y-2 text-sm">
            <div className="text-base font-semibold uppercase tracking-wider text-muted-foreground">
              Options ({parsed.length})
            </div>
            <div className="max-h-96 overflow-auto rounded border border-border">
              <table className="w-full table-fixed">
                {/* Explicit column widths keep the sticky header aligned with
                    the body even when <input type="date"> renders wider than
                    a plain text cell. Total ≈ 780px — narrower viewports
                    fall back to the wrapper's overflow-auto. */}
                <colgroup>
                  <col style={{ width: "130px" }} />{/* Date */}
                  <col style={{ width: "85px" }} />{/* Symbol */}
                  <col style={{ width: "85px" }} />{/* Action */}
                  <col style={{ width: "60px" }} />{/* Qty */}
                  <col style={{ width: "80px" }} />{/* Strike */}
                  <col style={{ width: "130px" }} />{/* Expiry */}
                  <col style={{ width: "70px" }} />{/* Type */}
                  <col style={{ width: "90px" }} />{/* Premium */}
                  <col style={{ width: "40px" }} />{/* Delete */}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-muted/40 text-left">
                  <tr>
                    <th className="whitespace-nowrap px-2 py-1">Date</th>
                    <th className="whitespace-nowrap px-2 py-1">Symbol</th>
                    <th className="whitespace-nowrap px-2 py-1">Action</th>
                    <th className="whitespace-nowrap px-2 py-1">Qty</th>
                    <th className="whitespace-nowrap px-2 py-1">Strike</th>
                    <th className="whitespace-nowrap px-2 py-1">Expiry</th>
                    <th className="whitespace-nowrap px-2 py-1">Type</th>
                    <th className="whitespace-nowrap px-2 py-1">Premium</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((t, idx) => {
                    // <input type="date"> only handles "YYYY-MM-DD" — slice
                    // any "T HH:MM:SS" suffix off the parsed value before
                    // rendering. When the user edits the date the value
                    // round-trips back to date-only, which is fine: the
                    // server's toPstDate() handles both forms.
                    const dateValue = (t.timePlaced ?? todayIso()).slice(0, 10);
                    const groupCount = t.spread_group
                      ? parsed.filter((p) => p.spread_group === t.spread_group).length
                      : 0;
                    const inGroup = groupCount >= 2;
                    return (
                      <tr
                        key={idx}
                        className={
                          inGroup
                            ? "border-t border-border bg-amber-500/5"
                            : "border-t border-border"
                        }
                      >
                        <td className="px-2 py-1">
                          <input
                            type="date"
                            value={dateValue}
                            onChange={(e) => updateRow(idx, { timePlaced: e.target.value })}
                            className="w-full rounded border border-border bg-background px-1 py-0.5"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
                            <input
                              value={t.symbol}
                              onChange={(e) => updateRow(idx, { symbol: e.target.value.toUpperCase() })}
                              className="w-16 rounded border border-border bg-background px-1 py-0.5 uppercase"
                            />
                            {inGroup && (
                              <span
                                title={`Linked leg — same order as another row (${t.spread_group})`}
                                className="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
                              >
                                Roll
                              </span>
                            )}
                          </div>
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
                            className="w-full rounded border border-border bg-background px-1 py-0.5"
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {parsedStocks && parsedStocks.length > 0 && (
          <div className="mt-3 space-y-2 text-sm">
            <div className="text-base font-semibold uppercase tracking-wider text-muted-foreground">
              Stocks ({parsedStocks.length})
            </div>
            <div className="max-h-80 overflow-auto rounded border border-border">
              <table className="w-full table-fixed">
                <colgroup>
                  <col style={{ width: "130px" }} />{/* Date */}
                  <col style={{ width: "85px" }} />{/* Symbol */}
                  <col style={{ width: "85px" }} />{/* Action */}
                  <col style={{ width: "90px" }} />{/* Shares */}
                  <col style={{ width: "100px" }} />{/* Price */}
                  <col style={{ width: "40px" }} />{/* Delete */}
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
                  {parsedStocks.map((s, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          value={s.date}
                          onChange={(e) => updateStockRow(idx, { date: e.target.value })}
                          className="w-full rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={s.symbol}
                          onChange={(e) =>
                            updateStockRow(idx, { symbol: e.target.value.toUpperCase() })
                          }
                          className="w-20 rounded border border-border bg-background px-1 py-0.5 uppercase"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={s.action}
                          onChange={(e) =>
                            updateStockRow(idx, {
                              action: e.target.value as "buy" | "sell",
                            })
                          }
                          className="rounded border border-border bg-background px-1 py-0.5"
                        >
                          <option value="buy">buy</option>
                          <option value="sell">sell</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="1"
                          value={s.shares}
                          onChange={(e) =>
                            updateStockRow(idx, {
                              shares: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                          className="w-20 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={s.price}
                          onChange={(e) =>
                            updateStockRow(idx, { price: Number(e.target.value) })
                          }
                          className="w-24 rounded border border-border bg-background px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-rose-300"
                          onClick={() => removeStockRow(idx)}
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
            <div className="text-[11px] text-muted-foreground">
              Stock sells match against open stock_long positions by (symbol, broker)
              and post realized P&L = (price − cost basis) × shares. Buys are not
              supported here — buy-side shares only enter via option assignment.
            </div>
          </div>
        )}

        {rejections.length > 0 && (
          <div className="mt-2 space-y-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-sm text-amber-100">
            <div className="font-semibold uppercase tracking-wide text-amber-200">
              {rejections.length} row{rejections.length === 1 ? "" : "s"} failed validation
            </div>
            {rejections.map((r, i) => (
              <div key={i}>
                ⚠️ <span className="font-mono">{r.symbol}</span>: {r.reason}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-sm text-rose-200">
            <div className="font-semibold">{error}</div>
            {errorList.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {errorList.map((e, i) => (
                  <li key={i} className="font-mono text-[11px]">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={parsing || confirming}>
            Cancel
          </Button>
          {((parsed && parsed.length > 0) ||
            (parsedStocks && parsedStocks.length > 0)) && (
            <Button onClick={confirm} disabled={confirming}>
              {confirming ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging…
                </>
              ) : (
                `Confirm & log all (${(parsed?.length ?? 0) + (parsedStocks?.length ?? 0)})`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
