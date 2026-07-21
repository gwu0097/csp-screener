"use client";

// TradingView embedded chart for the Deep Research page. TradingView
// serves its own data, so nothing is fetched from our API; if the
// iframe fails to load the box just stays empty and the rest of the
// page is unaffected.
//   studies: optional visible indicator panes below the price panel
//   (e.g. ["RSI@tv-basicstudies", "MACD@tv-basicstudies"]) — omitted
//   by default so existing callers (CSP Screener, Deep Research) are
//   unaffected.
//   height: container height in px; taller default when studies are
//   shown since each indicator adds its own pane below price/volume.
export function PriceChart({
  symbol,
  studies,
  height,
}: {
  symbol: string;
  studies?: string[];
  height?: number;
}) {
  const params: Record<string, string> = {
    symbol: symbol.toUpperCase(),
    interval: "D",
    theme: "dark",
    style: "1",
    locale: "en",
    hide_side_toolbar: "0",
    allow_symbol_change: "0",
    save_to_server: "0",
    withdateranges: "1",
  };
  if (studies && studies.length > 0) {
    params.studies = JSON.stringify(studies);
  }
  const src = "https://www.tradingview.com/widgetembed/?" + new URLSearchParams(params).toString();
  const h = height ?? (studies && studies.length > 0 ? 600 : 400);

  return (
    <div
      className="w-full overflow-hidden rounded-lg border bg-muted/20"
      style={{ height: `${h}px` }}
    >
      <iframe
        key={symbol}
        src={src}
        title={`${symbol.toUpperCase()} price chart`}
        className="h-full w-full"
        frameBorder="0"
        allowFullScreen
        loading="lazy"
      />
    </div>
  );
}
