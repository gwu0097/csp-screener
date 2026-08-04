"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

// Weekend/weekday-aware Schwab reconnect prompt. Always calls
// /api/schwab/token-status?verify=1 — a LIVE refresh attempt, not a
// read of the stored expiry — so the banner reflects whether Schwab
// actually accepted the token just now. It clears only when that live
// check comes back healthy; landing back on /dashboard after the
// OAuth redirect does not clear it on its own, only the next
// successful verify does. Renders nothing for members (the route is
// admin-only; a 401/403 here is expected and silent) and nothing
// while the connection is genuinely healthy on a weekday.
type StatusResp = {
  valid: boolean;
  status: "missing" | "expired" | "refresh_failed" | "warning" | "soft_warn" | "ok";
  expiresAt: string | null;
  expiresInDays: number | null;
  liveVerified: boolean;
};

export function SchwabStatusBanner() {
  const [resp, setResp] = useState<StatusResp | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schwab/token-status?verify=1", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<StatusResp>) : null))
      .then((j) => {
        if (!cancelled) setResp(j);
      })
      .catch(() => {
        if (!cancelled) setResp(null);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!checked || !resp) return null;

  const day = new Date().getDay(); // 0=Sun..6=Sat
  const isWeekend = day === 0 || day === 6;
  const isFailure =
    resp.status === "expired" || resp.status === "refresh_failed" || resp.status === "missing";
  const weekdayUrgent =
    !isWeekend && !isFailure && resp.expiresInDays !== null && resp.expiresInDays < 2;

  // Show on: any failure (any day), any weekend (regardless of time
  // remaining — nothing touches the token over a weekend until next
  // Saturday's health check), or a weekday within ~2 days of expiry.
  // Healthy weekday with >2 days left: no banner.
  const shouldShow = isFailure || isWeekend || weekdayUrgent;
  if (!shouldShow) return null;

  const expiresLabel = resp.expiresAt
    ? new Date(resp.expiresAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
    : "unknown";

  const message = isFailure
    ? `Schwab connection is down (live check just now: ${resp.status}). Reconnect to restore live chains and capture.`
    : isWeekend
      ? `Schwab token expires ${expiresLabel} — reconnect now to reset the clock to next Saturday's check instead of risking a weekday failure.`
      : `Schwab token expires ${expiresLabel} (${resp.expiresInDays?.toFixed(1)} days) — reconnect soon.`;

  const urgent = isFailure || weekdayUrgent;

  return (
    <div
      className={
        urgent
          ? "flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-200"
          : "flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
      }
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      <a
        href="/settings"
        className="shrink-0 rounded bg-foreground/10 px-2 py-1 text-xs font-medium hover:bg-foreground/20"
      >
        Reconnect
      </a>
    </div>
  );
}
