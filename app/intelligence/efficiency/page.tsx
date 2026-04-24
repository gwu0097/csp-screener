"use client";

import { useState } from "react";
import {
  BrokerControl,
  DateRangeControls,
  IntelligencePageShell,
  TickerRankingsSection,
  presetToRange,
  useIntelligenceData,
  type BrokerFilter,
  type DateRange,
} from "@/components/intelligence-shared";

export default function EfficiencyPage() {
  // Ticker-level comparison only gets meaningful with a big window, so
  // default to all-time. User can narrow via presets or manual dates.
  const [range, setRange] = useState<DateRange>(() => presetToRange("all"));
  const [broker, setBroker] = useState<BrokerFilter>("all");
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const { data, loading, error } = useIntelligenceData(range, broker);

  return (
    <IntelligencePageShell
      title="Capital Efficiency"
      controls={
        <>
          <DateRangeControls range={range} onChange={setRange} />
          <BrokerControl broker={broker} onChange={setBroker} />
        </>
      }
      error={error}
      loading={loading}
      data={data}
    >
      {data && (
        <TickerRankingsSection
          rankings={data.ticker_rankings}
          expandedSymbol={expandedSymbol}
          onToggleSymbol={(s) =>
            setExpandedSymbol((prev) => (prev === s ? null : s))
          }
        />
      )}
    </IntelligencePageShell>
  );
}
