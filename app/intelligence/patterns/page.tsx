"use client";

import { useState } from "react";
import {
  BrokerControl,
  DateRangeControls,
  IntelligencePageShell,
  PatternIntelligenceSection,
  presetToRange,
  useIntelligenceData,
  type BrokerFilter,
  type DateRange,
  type PresetKey,
} from "@/components/intelligence-shared";

export default function PatternsPage() {
  const [preset, setPreset] = useState<PresetKey>("all");
  const [range, setRange] = useState<DateRange>(() => presetToRange("all"));
  const [broker, setBroker] = useState<BrokerFilter>("all");
  const { data, loading, error } = useIntelligenceData(range, broker);

  return (
    <IntelligencePageShell
      title="Patterns"
      controls={
        <>
          <DateRangeControls
            range={range}
            preset={preset}
            onChange={({ preset: p, range: r }) => {
              setPreset(p);
              setRange(r);
            }}
          />
          <BrokerControl broker={broker} onChange={setBroker} />
        </>
      }
      error={error}
      loading={loading}
      data={data}
    >
      {data && <PatternIntelligenceSection patterns={data.patterns} />}
    </IntelligencePageShell>
  );
}
