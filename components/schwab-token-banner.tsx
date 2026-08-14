"use client";

// Proactive Schwab refresh-token expiry banner. Pulls
// /api/schwab/token-status on mount and renders a colored strip when
// the shared lib/schwab-token-warning check says to warn (or the token
// is missing/refresh-failed). Trigger AND copy both come from the
// route's shouldWarn/warningClause/warningMessage fields — this
// component does not compute its own days-remaining threshold.
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
        const [res, meRes] = await Promise.all([
          fetch("/api/schwab/token-status", { cache: "no-store" }),
          fetch("/api/auth/me", { cache: "no-store" }),
        ]);
        if (!cancelled && meRes.ok) {
          const me = (await meRes.json()) as { user?: { role?: string } };
          setIsAdmin(me.user?.role === "admin");
        }
        if (!res.ok) return;
        const json = (await res.json()) as TokenStatus;
        if (!cancelled) setStatus(json);
      } catch {
        /* network blip — silent; the route is informational */
      }
    })();
    return () => {
      cancelled = true;
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
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-sm opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
