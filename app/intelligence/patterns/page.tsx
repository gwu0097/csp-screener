"use client";

import { useState } from "react";
import {
  DateRangeControls,
  IntelligencePageShell,
  PatternIntelligenceSection,
  presetToRange,
  useIntelligenceData,
  type BrokerFilter,
  type DateRange,
} from "@/components/intelligence-shared";

export default function PatternsPage() {
  const [range, setRange] = useState<DateRange>(() => presetToRange("all"));
  const [broker, setBroker] = useState<BrokerFilter>("all");
  const { data, loading, error } = useIntelligenceData(range, broker);

  return (
    <IntelligencePageShell
      title="Patterns"
      controls={
        <DateRangeControls
          range={range}
          onRangeChange={setRange}
          broker={broker}
          onBrokerChange={setBroker}
        />
      }
      error={error}
      loading={loading}
      data={data}
    >
      {data && <PatternIntelligenceSection patterns={data.patterns} />}
    </IntelligencePageShell>
  );
}
