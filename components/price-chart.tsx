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
}: {
  symbol: string;
  studies?: string[];
  range?: string;
  height?: number;
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
      // Previous fix here set this to "1D", reasoning from the *rendered
      // chart's own UI dropdown labels* ("1","5","15","60","1H","2H",
      // "4H","1D","1W","1M") — those are display labels, not the embed
      // widget's config format. This widget (embed-widget-advanced-
      // chart.js) silently ignores an unrecognized interval and falls
      // back to an auto-picked intraday resolution, which is why "1D"
      // still rendered 2H: the KEY name is right (confirmed working
      // examples use this exact key with this exact script), the VALUE
      // format was wrong. TradingView's resolution spec allows omitting
      // the unit count when it's 1 ("D" instead of "1D") — bare "D" is
      // also the value used in verified-working embed-widget-advanced-
      // chart.js examples, unlike "1D" which is confirmed live-broken
      // on this widget. RSI/MACD are computed from daily bars elsewhere
      // in the app, so the chart must render daily candles to show
      // matching values.
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      support_host: "https://www.tradingview.com",
    };
    if (range) config.range = range;
    if (studies && studies.length > 0) config.studies = studies;

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = TV_SCRIPT_SRC;
    script.async = true;
    script.text = JSON.stringify(config);
    container.appendChild(script);
  }, [symbol, studies, range]);

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
