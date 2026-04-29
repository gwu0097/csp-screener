"use client";

// Reusable structured error banner. Pair with lib/errors.interpretError
// (or interpretFetchError) so raw HTTP status text never reaches the
// user — every banner shows title + detail + action + Retry/Dismiss.

import { AlertTriangle, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InterpretedError } from "@/lib/errors";

export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: InterpretedError;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
        <div className="flex-1 space-y-1">
          <div className="font-semibold text-rose-50">{error.title}</div>
          <div className="text-[12px] text-rose-200/90">{error.detail}</div>
          <div className="text-[12px] text-rose-200/70">{error.action}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {error.retryable && onRetry && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onRetry}
            className="border-rose-500/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25"
          >
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          className="text-rose-200/80 hover:bg-rose-500/10 hover:text-rose-100"
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}
