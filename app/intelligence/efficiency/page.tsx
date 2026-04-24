"use client";

import { useState } from "react";
import {
  IntelligencePageShell,
  TickerRankingsSection,
  useIntelligenceData,
  type Window,
} from "@/components/intelligence-shared";

export default function EfficiencyPage() {
  // Efficiency view uses the broadest window by default — ticker-level
  // ranking only becomes meaningful once enough closes have accumulated.
  const [window] = useState<Window>("all");
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const { data, loading, error } = useIntelligenceData(window);

  return (
    <IntelligencePageShell
      title="Capital Efficiency"
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
