"use client";

import { useState } from "react";
import {
  DateRangeControls,
  ExportSection,
  IntelligencePageShell,
  PerformanceSection,
  presetToRange,
  useIntelligenceData,
  type BrokerFilter,
  type DateRange,
} from "@/components/intelligence-shared";

export default function PerformancePage() {
  // Default to the current quarter, not month: campaigns are earnings-
  // driven and a season runs ~6 weeks straddling month boundaries, so
  // a calendar month is the one window guaranteed to split a season in
  // half. Quarter holds a full season plus context. The "Quarter"
  // button (PresetKey "last_quarter") already resolves to the current
  // calendar quarter, not the prior one — see presetToRange.
  const [range, setRange] = useState<DateRange>(() => presetToRange("last_quarter"));
  const [broker, setBroker] = useState<BrokerFilter>("all");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const { data, loading, error } = useIntelligenceData(range, broker);

  async function copyExport() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(data.export_payload, null, 2),
      );
      setCopyStatus("Intelligence JSON copied to clipboard");
      setTimeout(() => setCopyStatus(null), 3000);
    } catch {
      setCopyStatus("Copy failed");
      setTimeout(() => setCopyStatus(null), 3000);
    }
  }

  return (
    <IntelligencePageShell
      title="Performance"
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
      {data && (
        <>
          <PerformanceSection data={data} broker={broker} />
          <ExportSection onCopy={copyExport} copyStatus={copyStatus} />
        </>
      )}
    </IntelligencePageShell>
  );
}
