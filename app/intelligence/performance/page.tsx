"use client";

import { useState } from "react";
import {
  BrokerControl,
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
  const [range, setRange] = useState<DateRange>(() => presetToRange("month"));
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
        <>
          <PerformanceSection data={data} />
          <ExportSection onCopy={copyExport} copyStatus={copyStatus} />
        </>
      )}
    </IntelligencePageShell>
  );
}
