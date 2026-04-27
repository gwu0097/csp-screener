"use client";

// Comparable companies — peer multiples table. Subject row pinned at
// the top, peers sorted by ticker. Each cell coloured green when it's
// cheaper than the peer median (lower P/E etc.) and red when richer.

import type { CompsBlock } from "@/lib/valuation";

type Numeric = number | null;

function compareToMedian(value: Numeric, median: Numeric, lowerBetter: boolean): "green" | "red" | null {
  if (value === null || median === null || median === 0) return null;
  if (Math.abs(value - median) / median < 0.05) return null;
  if (lowerBetter) return value < median ? "green" : "red";
  return value > median ? "green" : "red";
}

function fmtMultiple(n: Numeric, suffix = "x"): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}${suffix}`;
}
function fmtPct(n: Numeric): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export function ValuationComps({
  symbol,
  comps,
}: {
  symbol: string;
  comps: CompsBlock | null;
}) {
  if (!comps || comps.peers.length === 0) {
    return (
      <div className="rounded border border-dashed border-border bg-background/40 p-3 text-xs text-muted-foreground">
        No peer data available for this sector.
      </div>
    );
  }

  // Subject row first, then peers (excluding the subject if it appears
  // in both — buildComps already includes it as the first row).
  const subject = comps.peers.find((p) => p.ticker === symbol) ?? null;
  const peers = comps.peers.filter((p) => p.ticker !== symbol);
  const ordered = subject ? [subject, ...peers] : peers;

  const subjectTrailing = subject?.trailing_pe ?? null;
  const medianTrailing = comps.median.trailing_pe;
  let narrative: string | null = null;
  if (
    subjectTrailing !== null &&
    medianTrailing !== null &&
    medianTrailing > 0
  ) {
    const ratio = subjectTrailing / medianTrailing;
    if (ratio < 0.7) {
      narrative = `${symbol} trades at ${subjectTrailing.toFixed(1)}x P/E vs peer median of ${medianTrailing.toFixed(1)}x — significant discount.`;
    } else if (ratio > 1.3) {
      narrative = `${symbol} trades at ${subjectTrailing.toFixed(1)}x P/E vs peer median of ${medianTrailing.toFixed(1)}x — premium to peers.`;
    } else {
      narrative = `${symbol} trades at ${subjectTrailing.toFixed(1)}x P/E vs peer median of ${medianTrailing.toFixed(1)}x — roughly in line with peers.`;
    }
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Comparable companies
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                Ticker
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                P/E (TTM)
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                P/E (Fwd)
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                EV/EBITDA
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                P/S
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                ROE
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                Rev Growth
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => {
              const isSubject = row.ticker === symbol;
              return (
                <tr
                  key={row.ticker}
                  className={`border-t border-border ${
                    isSubject ? "bg-emerald-500/[0.06]" : ""
                  }`}
                >
                  <td
                    className={`px-2 py-1 font-mono ${isSubject ? "font-semibold text-foreground" : "text-foreground"}`}
                  >
                    {row.ticker}
                    {isSubject && (
                      <span className="ml-2 text-[9px] text-emerald-300/80">
                        SUBJECT
                      </span>
                    )}
                  </td>
                  <Cell
                    value={row.trailing_pe}
                    median={comps.median.trailing_pe}
                    lowerBetter
                    fmt={(n) => fmtMultiple(n)}
                  />
                  <Cell
                    value={row.forward_pe}
                    median={comps.median.forward_pe}
                    lowerBetter
                    fmt={(n) => fmtMultiple(n)}
                  />
                  <Cell
                    value={row.ev_to_ebitda}
                    median={comps.median.ev_to_ebitda}
                    lowerBetter
                    fmt={(n) => fmtMultiple(n)}
                  />
                  <Cell
                    value={row.price_to_sales}
                    median={comps.median.price_to_sales}
                    lowerBetter
                    fmt={(n) => fmtMultiple(n)}
                  />
                  <td className="px-2 py-1 text-right font-mono">
                    {fmtPct(row.return_on_equity)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {fmtPct(row.revenue_growth)}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-border bg-background/60 text-muted-foreground">
              <td className="px-2 py-1 font-mono">Median</td>
              <td className="px-2 py-1 text-right font-mono">
                {fmtMultiple(comps.median.trailing_pe)}
              </td>
              <td className="px-2 py-1 text-right font-mono">
                {fmtMultiple(comps.median.forward_pe)}
              </td>
              <td className="px-2 py-1 text-right font-mono">
                {fmtMultiple(comps.median.ev_to_ebitda)}
              </td>
              <td className="px-2 py-1 text-right font-mono">
                {fmtMultiple(comps.median.price_to_sales)}
              </td>
              <td className="px-2 py-1 text-right font-mono">—</td>
              <td className="px-2 py-1 text-right font-mono">—</td>
            </tr>
          </tbody>
        </table>
      </div>
      {narrative && (
        <div className="mt-1 text-[11px] text-muted-foreground">{narrative}</div>
      )}
    </div>
  );
}

function Cell({
  value,
  median,
  lowerBetter,
  fmt,
}: {
  value: Numeric;
  median: Numeric;
  lowerBetter: boolean;
  fmt: (n: Numeric) => string;
}) {
  const c = compareToMedian(value, median, lowerBetter);
  const cls =
    c === "green"
      ? "text-emerald-300"
      : c === "red"
        ? "text-rose-300"
        : "text-foreground";
  return (
    <td className={`px-2 py-1 text-right font-mono ${cls}`}>{fmt(value)}</td>
  );
}
