"use client";

import { useEffect, useRef } from "react";

// TradingView's officially documented embed method: a
// tradingview-widget-container div + their own loader script reading
// a JSON config from the script tag's text content. This is NOT the
// same as pointing an <iframe src=...> at tradingview.com/widgetembed/
// with query params — that internal page doesn't honor `studies` or
// `range` at all (confirmed by diffing its output with/without those
// params). The loader script, once it runs, builds its own internal
// iframe — TradingView still serves its own data, nothing is fetched
// from our API, and a failed load just leaves the box empty.
//   studies: optional visible indicator panes below the price panel
//   (e.g. ["STD;RSI", "STD;MACD"]) — omitted by default so existing
//   callers (CSP Screener, Deep Research) are unaffected.
//   range: default visible date range (e.g. "6M"); omitted lets
//   TradingView pick its own default, matching prior behavior for
//   existing callers.
//   height: container height in px; taller default when studies are
//   shown since each indicator adds its own pane below price/volume.
const TV_SCRIPT_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export function PriceChart({
  symbol,
  studies,
  range,
  height,
  showDateRangeSelector = true,
}: {
  symbol: string;
  studies?: string[];
  range?: string;
  height?: number;
  // Default true preserves existing behavior for every caller that
  // doesn't pass this. Set false to drop BOTH withdateranges and range
  // from the config entirely — see the comment above `interval` in the
  // config object for why. Two interval-value fixes ("1D", then "D")
  // both failed to change the rendered chart, which means something
  // else in this config is the actual controlling factor; withdateranges
  // (an interactive range-button UI that plausibly carries its own
  // range->resolution auto-mapping, the same class of behavior
  // TradingView's own site exhibits when you click a date-range button)
  // is the strongest remaining suspect, with `range` removed alongside
  // it since I can't independently verify from this environment which
  // of the two is actually responsible — no browser/screenshot tool is
  // available here, so this couldn't be tested before shipping. If a
  // caller's chart needs its interval to reliably match an externally-
  // computed indicator value (Buy Zone's RSI/MACD score, computed on
  // daily bars), pass false.
  showDateRangeSelector?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Full clear + re-inject on symbol/config change — TradingView's
    // loader script only runs once per script-tag insertion, so a
    // fresh element is required rather than mutating in place.
    container.innerHTML = "";
    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget h-full w-full";
    container.appendChild(widgetDiv);

    const config: Record<string, unknown> = {
      autosize: true,
      symbol: symbol.toUpperCase(),
      // History, honestly: two different interval values ("1D", then
      // "D") were tried here and NEITHER changed the rendered chart —
      // strong evidence the value format was never the actual problem.
      // "D" is kept because it's the value used in the one real working
      // embed-widget-advanced-chart.js example found during
      // investigation (not because it's been confirmed to matter here).
      // The real suspect is withdateranges/range below — see
      // showDateRangeSelector's comment on the component signature.
      // No browser is available in this dev environment to confirm any
      // of this by rendering the page; treat "D" as a reasonable,
      // unverified default, not a proven-correct value.
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_side_toolbar: false,
      allow_symbol_change: false,
      support_host: "https://www.tradingview.com",
    };
    if (showDateRangeSelector) {
      config.withdateranges = true;
      if (range) config.range = range;
    }
    if (studies && studies.length > 0) config.studies = studies;

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = TV_SCRIPT_SRC;
    script.async = true;
    script.text = JSON.stringify(config);
    container.appendChild(script);
  }, [symbol, studies, range, showDateRangeSelector]);

  const h = height ?? (studies && studies.length > 0 ? 600 : 400);

  return (
    <div
      className="w-full overflow-hidden rounded-lg border bg-muted/20"
      style={{ height: `${h}px` }}
    >
      <div ref={containerRef} className="tradingview-widget-container h-full w-full" />
    </div>
  );
}
