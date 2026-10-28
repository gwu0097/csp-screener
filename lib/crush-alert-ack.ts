// "Dismiss" for the T0/T1 crush-capture attention card
// (components/capture-health-panel.tsx). Pure — no I/O — so the
// reshow rule is unit-testable (lib/crush-alert-ack.test.ts).
//
// A dismissal acknowledges the exact set of issues on screen. The card
// stays collapsed until an issue appears that wasn't in that set: a new
// failed or missed day, a day whose failed count went up, or a new
// aged-out row. Issues that roll off the 7-day window don't reshow it.

export type AckDay = { date: string; state: string; failed: number };

export function crushIssueKeys(
  t0Days: readonly AckDay[],
  t1Days: readonly AckDay[],
  unrecoverableIds: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const [phase, days] of [["t0", t0Days], ["t1", t1Days]] as const) {
    for (const d of days) {
      if (d.state === "no_run") keys.push(`${phase}|${d.date}|no_run`);
      // Count is part of the key so a day that gets worse reshows.
      else if (d.state === "ran_failed") keys.push(`${phase}|${d.date}|failed:${d.failed}`);
    }
  }
  for (const id of unrecoverableIds) keys.push(`unrecoverable|${id}`);
  return keys.sort();
}

// True when every current issue was already acknowledged. No issues at
// all is not "acknowledged" — the card is simply healthy then.
export function isAcknowledged(current: readonly string[], acked: readonly string[] | null): boolean {
  if (!acked || current.length === 0) return false;
  const seen = new Set(acked);
  return current.every((k) => seen.has(k));
}
