// Pure helpers for the Analysis Dump's capture-timestamp reporting and
// chain-staleness warning (components/screener-view.tsx's
// AnalysisDumpTab). Split out from the component so the date/threshold
// arithmetic — the part most likely to hide an off-by-one bug — is
// unit-testable without mounting React.
//
// Chain data decays faster than spot on earnings day (IV moves sharply
// into the close), so the chain gets its own, tighter threshold rather
// than reusing any spot-staleness notion.
export const CHAIN_STALENESS_THRESHOLD_MINUTES = 30;

export function minutesAgo(at: Date | null, nowMs: number): number | null {
  if (at === null) return null;
  return Math.max(0, Math.round((nowMs - at.getTime()) / 60000));
}

export function formatCapturedLine(label: string, at: Date | null, nowMs: number): string {
  const age = minutesAgo(at, nowMs);
  if (at === null || age === null) {
    return `${label}: unknown — no capture timestamp available`;
  }
  return `${label}: ${at.toISOString()} (${age} min ago)`;
}

export function isChainStale(
  chainCapturedAt: Date | null,
  nowMs: number,
  thresholdMinutes: number = CHAIN_STALENESS_THRESHOLD_MINUTES,
): boolean {
  const age = minutesAgo(chainCapturedAt, nowMs);
  return age !== null && age > thresholdMinutes;
}
