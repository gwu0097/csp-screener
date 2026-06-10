"use client";

// 90-day price chart for the Deep Research page (lightweight-charts).
// Candlesticks from snapshot.historical_90d, with SMA50/SMA200 and the
// analyst target as horizontal reference lines. Falls back to an area
// chart of price_history_5d when the 90d series isn't cached yet, and
// renders nothing if the snapshot can't be loaded at all.
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type AreaData,
  type Time,
  type MouseEventParams,
} from "lightweight-charts";

type Bar90 = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

type ChartSnapshot = {
  price: number | null;
  sma50: number | null;
  sma200: number | null;
  analyst_target: number | null;
  price_history_5d: Array<{ date: string; close: number }> | null;
  historical_90d: Bar90[] | null;
};

const UP_COLOR = "#10b981"; // emerald-500
const DOWN_COLOR = "#f43f5e"; // rose-500
const GRID_COLOR = "rgba(148, 163, 184, 0.08)";
const TEXT_COLOR = "#94a3b8"; // slate-400

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function PriceChart({ symbol }: { symbol: string }) {
  const [snap, setSnap] = useState<ChartSnapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setSnap(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/market/snapshot?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { snapshot?: ChartSnapshot };
        if (cancelled) return;
        const s = json.snapshot ?? null;
        const hasData =
          (s?.historical_90d?.length ?? 0) > 1 ||
          (s?.price_history_5d?.length ?? 0) > 1;
        setSnap(s);
        setState(hasData ? "ready" : "failed");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    if (state !== "ready" || !snap || !containerRef.current) return;
    const container = containerRef.current;

    const chart: IChartApi = createChart(container, {
      width: container.clientWidth,
      height: 280,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: TEXT_COLOR,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: GRID_COLOR },
      timeScale: { borderColor: GRID_COLOR },
    });

    const bars = snap.historical_90d ?? [];
    let series: ISeriesApi<"Candlestick"> | ISeriesApi<"Area">;
    if (bars.length > 1) {
      series = chart.addSeries(CandlestickSeries, {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        borderUpColor: UP_COLOR,
        borderDownColor: DOWN_COLOR,
        wickUpColor: UP_COLOR,
        wickDownColor: DOWN_COLOR,
      });
      series.setData(
        bars.map(
          (b): CandlestickData => ({
            time: b.date as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          }),
        ),
      );
    } else {
      // Pre-migration cached snapshot: closes only → area chart.
      series = chart.addSeries(AreaSeries, {
        lineColor: UP_COLOR,
        topColor: "rgba(16, 185, 129, 0.25)",
        bottomColor: "rgba(16, 185, 129, 0)",
      });
      series.setData(
        (snap.price_history_5d ?? []).map(
          (p): AreaData => ({ time: p.date as Time, value: p.close }),
        ),
      );
    }

    if (snap.sma50 !== null) {
      series.createPriceLine({
        price: snap.sma50,
        color: "#3b82f6",
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "SMA50",
      });
    }
    if (snap.sma200 !== null) {
      series.createPriceLine({
        price: snap.sma200,
        color: "#f59e0b",
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "SMA200",
      });
    }
    if (snap.analyst_target !== null) {
      series.createPriceLine({
        price: snap.analyst_target,
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Target $${fmt(snap.analyst_target)}`,
      });
    }

    // OHLC + date legend driven by the crosshair.
    const onCrosshair = (param: MouseEventParams) => {
      const el = legendRef.current;
      if (!el) return;
      const d = param.time ? param.seriesData.get(series) : undefined;
      if (!d) {
        el.textContent = "";
        return;
      }
      if ("open" in d) {
        const c = d as CandlestickData;
        el.textContent = `${param.time}  O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}`;
      } else if ("value" in d) {
        el.textContent = `${param.time}  ${fmt((d as AreaData).value)}`;
      }
    };
    chart.subscribeCrosshairMove(onCrosshair);

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
    };
  }, [state, snap]);

  if (state === "failed") return null;
  if (state === "loading") {
    return <div className="h-[280px] w-full animate-pulse rounded-lg bg-muted/40" />;
  }
  return (
    <div className="relative w-full">
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-2 top-1 z-10 font-mono text-xs text-muted-foreground"
      />
      <div ref={containerRef} className="h-[280px] w-full" />
    </div>
  );
}
