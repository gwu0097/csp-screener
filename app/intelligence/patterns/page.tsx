"use client";

import { useState } from "react";
import {
  IntelligencePageShell,
  PatternIntelligenceSection,
  useIntelligenceData,
  type Window,
} from "@/components/intelligence-shared";

export default function PatternsPage() {
  const [window] = useState<Window>("all");
  const { data, loading, error } = useIntelligenceData(window);

  return (
    <IntelligencePageShell
      title="Patterns"
      error={error}
      loading={loading}
      data={data}
    >
      {data && <PatternIntelligenceSection patterns={data.patterns} />}
    </IntelligencePageShell>
  );
}
