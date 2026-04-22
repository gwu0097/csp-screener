"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EquityPoint } from "@/lib/journal";
import { fmtDollarsSigned } from "@/lib/format";

export type EquityRange = "1W" | "1M" | "3M" | "YTD" | "ALL";

type Props = {
  points: EquityPoint[];
  range: EquityRange;
};

function rangeStart(range: EquityRange): string {
  const now = new Date();
  if (range === "ALL") return "0000-01-01";
  if (range === "YTD") return `${now.getFullYear()}-01-01`;
  const days = range === "1W" ? 7 : range === "1M" ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function EquityCurve({ points, range }: Props) {
  const filtered = useMemo(() => {
    const cutoff = rangeStart(range);
    // Rebase cumulative P&L so the earliest point in the window starts at 0.
    // Without this, the chart is shifted up/down by historical P&L and the
    // curve's shape within the window is harder to read.
    const windowed = points.filter((p) => p.date >= cutoff);
    if (windowed.length === 0) return windowed;
    const base = windowed[0].cumPnl - windowed[0].pnl;
    return windowed.map((p) => ({ ...p, cumPnl: p.cumPnl - base }));
  }, [points, range]);

  if (filtered.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-background/40 text-xs text-muted-foreground">
        No realized trades in this range
      </div>
    );
  }

  const last = filtered[filtered.length - 1].cumPnl;
  const positive = last >= 0;
  // Tailwind's default colors: emerald-400 / rose-400. Rechart needs raw hex.
  const stroke = positive ? "#34d399" : "#fb7185";
  const fillId = positive ? "equity-fill-pos" : "equity-fill-neg";

  return (
    <div className="h-64 rounded-lg border border-border bg-background/40 p-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={filtered} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="equity-fill-pos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#34d399" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="equity-fill-neg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#fb7185" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#fb7185" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            minTickGap={40}
          />
          <YAxis
            width={60}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={(v: number) => fmtDollarsSigned(v)}
          />
          <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
          <Tooltip
            contentStyle={{
              background: "#0b0f19",
              border: "1px solid #27272a",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: "#d4d4d8" }}
            formatter={(v) => [fmtDollarsSigned(typeof v === "number" ? v : Number(v)), "Cum P&L"] as [string, string]}
          />
          <Area
            type="monotone"
            dataKey="cumPnl"
            stroke={stroke}
            strokeWidth={2}
            fill={`url(#${fillId})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
