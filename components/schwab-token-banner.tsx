"use client";

// Proactive Schwab refresh-token expiry banner. Pulls
// /api/schwab/token-status on mount and renders a colored strip when
// the refresh token is within ~3 days of expiring. Expired or
// missing tokens get the red strip — same surface as the existing
// auth-error path but fired BEFORE the next options call fails, not
// after.
//
// The Reconnect link points at /api/auth/schwab which redirects into
// Schwab's OAuth flow; the existing callback persists the new
// tokens and updates updated_at, so the banner self-clears on next
// mount after a successful reconnect.

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type Status = "missing" | "expired" | "warning" | "soft_warn" | "ok";

type TokenStatus = {
  valid: boolean;
  status: Status;
  expiresAt: string | null;
  expiresInDays: number | null;
  ageHours: number | null;
};

function fmtDays(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return "—";
  if (d < 0) return "expired";
  if (d < 1) {
    const hrs = Math.max(0, Math.round(d * 24));
    return `${hrs} hour${hrs === 1 ? "" : "s"}`;
  }
  const days = Math.floor(d);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function SchwabTokenBanner() {
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/schwab/token-status", {
          cache: "no-store",
        });
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
  if (status.status === "ok" || status.status === "missing") return null;
  // Note: "missing" is hidden because the rest of the app already
  // surfaces "Connect Schwab to run analysis" at the action sites.
  // The banner is for the in-between cases where the user IS
  // connected but about to lose access.

  const { status: kind, expiresInDays } = status;
  const tone =
    kind === "expired" || kind === "warning"
      ? kind === "expired"
        ? "red"
        : "orange"
      : "yellow";

  const palette =
    tone === "red"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
      : tone === "orange"
        ? "border-orange-500/40 bg-orange-500/10 text-orange-100"
        : "border-amber-500/40 bg-amber-500/10 text-amber-100";

  const title =
    kind === "expired"
      ? "Schwab token expired — reconnect to restore options data."
      : kind === "warning" && expiresInDays !== null && expiresInDays < 1
        ? "Schwab token expires within 24 hours. Reconnect now."
        : kind === "warning"
          ? `Schwab token expires in ~${fmtDays(expiresInDays)}. Reconnect now.`
          : `Schwab token expires in ~${fmtDays(expiresInDays)}. Reconnect soon to avoid interruption.`;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${palette}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="/api/auth/schwab"
          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-semibold ${
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
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-xs opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
