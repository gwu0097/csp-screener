"use client";

import { useState } from "react";
import {
  ExportSection,
  IntelligencePageShell,
  PerformanceSection,
  useIntelligenceData,
  type Window,
} from "@/components/intelligence-shared";

export default function PerformancePage() {
  const [window, setWindow] = useState<Window>("month");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const { data, loading, error } = useIntelligenceData(window);

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
      error={error}
      loading={loading}
      data={data}
    >
      {data && (
        <>
          <PerformanceSection
            data={data}
            window={window}
            onWindowChange={setWindow}
          />
          <ExportSection onCopy={copyExport} copyStatus={copyStatus} />
        </>
      )}
    </IntelligencePageShell>
  );
}
