"use client";

// Proactive Schwab refresh-token expiry banner. Polls
// /api/schwab/token-status on mount and every 5 minutes thereafter,
// and renders a colored strip when the shared lib/schwab-token-warning
// check says to warn (or the token is missing/refresh-failed). Trigger
// AND copy both come from the route's shouldWarn/warningClause/
// warningMessage fields — this component does not compute its own
// days-remaining threshold.
//
// Dismissal is in-memory only (no persistence — resets on remount),
// and is not offered at all for clause 4 (expired or under 24 hours):
// that condition cannot be dismissed away, and a poll that escalates
// to clause 4 clears any prior dismissal of a lower-severity clause.
//
// The Reconnect link points at /api/auth/schwab which redirects into
// Schwab's OAuth flow; the existing callback persists the new
// tokens and updates updated_at, so the banner self-clears on next
// mount after a successful reconnect.

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type Status = "missing" | "expired" | "refresh_failed" | "ok";

type TokenStatus = {
  valid: boolean;
  status: Status;
  expiresAt: string | null;
  expiresInDays: number | null;
  ageHours: number | null;
  accessExpiresAt?: string | null;
  accessExpired?: boolean;
  refreshAttempted?: boolean;
  refreshError?: string | null;
  shouldWarn: boolean;
  warningClause: 1 | 2 | 3 | 4 | null;
  warningMessage: string;
};

export function SchwabTokenBanner() {
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // The Schwab connection belongs to the admin — members get a
  // "market data unavailable" note instead of a reconnect CTA.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", { cache: "no-store" });
        if (!cancelled && meRes.ok) {
          const me = (await meRes.json()) as { user?: { role?: string } };
          setIsAdmin(me.user?.role === "admin");
        }
      } catch {
        /* network blip — silent; role check is informational */
      }
    })();

    // Polled on mount and every 5 minutes below, so a long-lived open
    // tab picks up an expiry crossing the clause-4 24-hour line, or a
    // refresh starting to fail, without a manual reload. 5 minutes
    // surfaces a clause-4 transition well within a session while
    // adding only a handful of extra cheap DB reads per hour — access
    // tokens already refresh on their own 30-min cycle regardless of
    // this interval, so it doesn't add meaningful extra load on Schwab.
    const pollTokenStatus = async () => {
      try {
        const res = await fetch("/api/schwab/token-status", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as TokenStatus;
        if (cancelled) return;
        setStatus(json);
        // Clause 4 has no dismiss control (see render below) — if a
        // poll escalates to clause 4 while a lower-severity clause was
        // previously dismissed, clear that dismissal so it reappears.
        if (json.warningClause === 4) setDismissed(false);
      } catch {
        /* network blip — silent; the route is informational */
      }
    };

    pollTokenStatus();
    const intervalId = setInterval(pollTokenStatus, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  if (!status || dismissed) return null;
  // "missing" is hidden because the rest of the app already surfaces
  // "Connect Schwab to run analysis" at the action sites. The banner is
  // for the in-between cases where the user IS connected but either
  // has an active failure or is approaching/inside a reconnect window.
  if (status.status === "missing") return null;
  const isFailure = status.status === "refresh_failed";
  if (!isFailure && !status.shouldWarn) return null;

  const tone: "red" | "orange" | "amber" = isFailure
    ? "red"
    : status.warningClause === 4
      ? "red"
      : status.warningClause === 2
        ? "orange"
        : "amber";

  const palette =
    tone === "red"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
      : tone === "orange"
        ? "border-orange-500/40 bg-orange-500/10 text-orange-100"
        : "border-amber-500/40 bg-amber-500/10 text-amber-100";

  const title = !isAdmin
    ? isFailure
      ? "Live market data unavailable — the admin's broker connection is down."
      : "Live market data may pause soon — the admin's broker token needs reconnecting."
    : isFailure
      ? `Schwab auto-refresh failed${status.refreshError ? ` (${status.refreshError})` : ""}. Reconnect to restore live data.`
      : status.warningMessage;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-base ${palette}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {isAdmin && (
          <a
            href="/api/auth/schwab"
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm font-semibold ${
              tone === "red"
                ? "border-rose-300/40 bg-rose-500/20 hover:bg-rose-500/30"
                : tone === "orange"
                  ? "border-orange-300/40 bg-orange-500/20 hover:bg-orange-500/30"
                  : "border-amber-300/40 bg-amber-500/20 hover:bg-amber-500/30"
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reconnect Schwab
          </a>
        )}
        {status.warningClause !== 4 && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-sm opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
