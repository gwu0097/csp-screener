"use client";

// TradingView embedded chart for the Deep Research page. TradingView
// serves its own data, so nothing is fetched from our API; if the
// iframe fails to load the box just stays empty and the rest of the
// page is unaffected.
export function PriceChart({ symbol }: { symbol: string }) {
  const src =
    "https://www.tradingview.com/widgetembed/?" +
    new URLSearchParams({
      symbol: symbol.toUpperCase(),
      interval: "D",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_side_toolbar: "0",
      allow_symbol_change: "0",
      save_to_server: "0",
      withdateranges: "1",
    }).toString();

  return (
    <div className="h-[400px] w-full overflow-hidden rounded-lg border bg-muted/20">
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
