// Central error interpreter for client-facing failures. Maps HTTP
// status codes (and unknown errors) to a structured shape the
// reusable ErrorBanner component renders consistently — title,
// one-sentence detail, one-sentence action, retryable flag.
//
// Use anywhere a fetch result becomes user-visible. The goal is to
// make sure raw "HTTP 504" / "TypeError: fetch failed" strings never
// surface; the user always sees the explanation + the next step.

export type InterpretedError = {
  title: string;
  detail: string;
  action: string;
  retryable: boolean;
  // Machine-readable label so analytics / telemetry can group cases
  // (TIMEOUT / RATE_LIMIT / AUTH / etc.). Optional — banner doesn't
  // render it.
  code?: string;
  // Echoed for telemetry only; the banner doesn't display this.
  rawStatus?: number | null;
  rawMessage?: string;
};

// Some routes embed the failing pass in the body so the message can
// be specific (e.g. "Screen Today timed out during options lookup").
type ContextualOpts = {
  // Free-form sub-context like "options lookup (Pass 2)".
  passLabel?: string | null;
  // Server-provided body, e.g. { error, code, retryable, context }.
  body?: { error?: string; code?: string; context?: string } | null;
};

export function interpretError(
  err: unknown,
  context: string,
  opts: ContextualOpts = {},
): InterpretedError {
  const status = extractStatus(err);
  const rawMessage = extractMessage(err);
  const passLabel = opts.passLabel ?? opts.body?.context ?? null;

  const titleScope = passLabel ? `${context} — ${passLabel}` : context;

  if (status === 504 || status === 408) {
    const detail = passLabel
      ? `${capitalizeFirst(passLabel)} took too long to respond. Schwab and Finnhub are the usual culprits during high-traffic periods.`
      : "A data fetch took too long to respond. Schwab or Finnhub during high-traffic periods is the usual cause.";
    return {
      title: `${titleScope} timed out`,
      detail,
      action:
        context === "Screen Today" && !passLabel
          ? "Try again — it usually works on retry. If it keeps timing out, run during market hours when Schwab is fastest."
          : "Try again — it usually works on retry.",
      retryable: true,
      code: "TIMEOUT",
      rawStatus: status,
      rawMessage,
    };
  }
  if (status === 503) {
    return {
      title: "Service temporarily unavailable",
      detail: "Schwab, Finnhub, or Perplexity may be down briefly.",
      action: "Wait 2-3 minutes and try again.",
      retryable: true,
      code: "UNAVAILABLE",
      rawStatus: status,
      rawMessage,
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: "Schwab authentication expired",
      detail: "Your Schwab session needs to be refreshed.",
      action: "Go to Settings → reconnect Schwab, then retry.",
      retryable: false,
      code: "AUTH",
      rawStatus: status,
      rawMessage,
    };
  }
  if (status === 429) {
    return {
      title: "Rate limit hit",
      detail: "Too many requests to Finnhub or Schwab in a short window.",
      action: "Wait 60 seconds and try again.",
      retryable: true,
      code: "RATE_LIMIT",
      rawStatus: status,
      rawMessage,
    };
  }
  if (status === 404) {
    return {
      title: `${titleScope} — not found`,
      detail:
        opts.body?.error ??
        "The route or resource isn't available for this symbol.",
      action: "Check the symbol or try a different action.",
      retryable: false,
      code: "NOT_FOUND",
      rawStatus: status,
      rawMessage,
    };
  }
  if (status === 500 || status === 502) {
    return {
      title: `${titleScope} — server error`,
      detail: opts.body?.error ?? rawMessage ?? "Something went wrong on our end.",
      action: "Try again. If it persists, check Vercel logs for the stack.",
      retryable: true,
      code: "SERVER_ERROR",
      rawStatus: status,
      rawMessage,
    };
  }
  // Network / unknown — no status. Likely fetch threw before reaching
  // the server, or we're parsing JSON we couldn't read.
  return {
    title: `${titleScope} failed`,
    detail:
      rawMessage ??
      "An unexpected error occurred. Could be a network blip or a CORS hiccup.",
    action: "Try again or reload the page.",
    retryable: true,
    code: "UNKNOWN",
    rawStatus: status,
    rawMessage,
  };
}

// Coerce common error shapes into a status code. Accepts:
//   - { status: number }                — Response objects
//   - { statusCode: number }            — Some libraries
//   - { response: { status: number } }  — Axios-style
//   - undefined                         — when Error.message is the only signal
function extractStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
    const r = e.response as Record<string, unknown> | undefined;
    if (r && typeof r.status === "number") return r.status;
  }
  // Pull out a status from a stringified error like
  // "Network error 504" — best-effort, only when nothing else worked.
  const msg = extractMessage(err);
  if (msg) {
    const m = msg.match(/\b(\d{3})\b/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 400 && n < 600) return n;
    }
  }
  return null;
}

function extractMessage(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.error === "string") return e.error;
    if (typeof e.message === "string") return e.message;
  }
  return undefined;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Convenience: build an InterpretedError directly from a fetch
// Response, parsing the JSON body if available so server-side `code`
// and `context` flow into the message. Use this when you'd otherwise
// construct an ad-hoc error from a !res.ok branch.
export async function interpretFetchError(
  res: Response,
  context: string,
  opts: { passLabel?: string | null } = {},
): Promise<InterpretedError> {
  let body: { error?: string; code?: string; context?: string } | null = null;
  try {
    body = (await res.json()) as { error?: string; code?: string; context?: string };
  } catch {
    /* non-JSON body (HTML 504 page, etc.) — fall through */
  }
  const fakeError = {
    status: res.status,
    message: body?.error ?? `HTTP ${res.status}`,
  };
  return interpretError(fakeError, context, { ...opts, body });
}
