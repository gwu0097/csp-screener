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
// admin-only; a 401/403 here is expected and silent).
//
// Trigger AND copy come from the route's shouldWarn/warningClause/
// warningMessage — computed server-side by
// lib/schwab-token-warning.evaluateSchwabTokenWarning in
// America/Los_Angeles, not from the browser's own clock/timezone (the
// previous version read `new Date().getDay()` client-side, which used
// whichever timezone the visitor's OS happened to be set to).
type StatusResp = {
  valid: boolean;
  status: "missing" | "expired" | "refresh_failed" | "ok";
  expiresAt: string | null;
  expiresInDays: number | null;
  liveVerified: boolean;
  shouldWarn: boolean;
  warningClause: 1 | 2 | 3 | 4 | null;
  warningMessage: string;
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

  const isFailure =
    resp.status === "expired" || resp.status === "refresh_failed" || resp.status === "missing";
  const shouldShow = isFailure || resp.shouldWarn;
  if (!shouldShow) return null;

  const message = isFailure
    ? `Schwab connection is down (live check just now: ${resp.status}). Reconnect to restore live chains and capture.`
    : resp.warningMessage;

  // Clause 4 (expired/<24h) reads as urgent regardless of what fired
  // it; clauses 1-3 are the routine weekend-cycle reminders.
  const urgent = isFailure || resp.warningClause === 4;

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
