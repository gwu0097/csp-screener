"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, X, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";

type Props = {
  connected: boolean;
  lastRefresh: string | null;
  envFlags: Record<string, boolean>;
  schwabFlash: string | null;
  schwabReason: string | null;
};

export function SettingsView({ connected, lastRefresh, envFlags, schwabFlash, schwabReason }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      await fetch("/api/auth/schwab", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {/* Polygon subscription is paid through ~end of May. Bulk-
          backfill any historical EM rows that don't have a Polygon
          implied_move_pct yet — once the sub lapses, those rows
          can't be filled at all (Schwab is live-only). */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-base text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Polygon subscription active</div>
            <div className="mt-0.5 text-amber-200/90">
              Backfill historical EM data before the subscription expires
              to maximize crush-history accuracy. Use the &quot;Backfill
              historical EM (Polygon)&quot; button below — it drains
              every <code>earnings_history</code> row that has an actual
              move but no implied move.
            </div>
          </div>
        </div>
      </div>

      {schwabFlash === "connected" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-base text-emerald-300">
          Schwab connected successfully.
        </div>
      )}
      {schwabFlash === "error" && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-base text-rose-300">
          Schwab connection failed{schwabReason ? `: ${schwabReason}` : ""}.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Schwab connection
            <Badge variant={connected ? "default" : "destructive"}>{connected ? "connected" : "disconnected"}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-base text-muted-foreground">
            Last refresh: {lastRefresh ? new Date(lastRefresh).toLocaleString() : "never"}
          </div>
          <div className="flex gap-2">
            {!connected && (
              <Button asChild>
                <a href="/api/auth/schwab">Connect Schwab</a>
              </Button>
            )}
            {connected && (
              <Button variant="destructive" onClick={disconnect} disabled={busy}>
                {busy ? "Disconnecting…" : "Disconnect"}
              </Button>
            )}
          </div>

          <ManualTokenSection onSaved={() => router.refresh()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Encyclopedia maintenance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <PolygonBulkBackfill />
          <ImpliedMoveBackfill />
          <RekeySymbol />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment variables</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-base">
            {Object.entries(envFlags).map(([k, present]) => (
              <li key={k} className="flex items-center justify-between py-2">
                <code className="font-mono">{k}</code>
                {present ? (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <Check className="h-4 w-4" /> set
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-rose-300">
                    <X className="h-4 w-4" /> missing
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            Values are never shown. Set them in <code>.env.local</code> or in your Vercel project settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ManualTokenSection({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/schwab/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setMessage({ kind: "ok", text: "Tokens saved." });
      setAccessToken("");
      setRefreshToken("");
      onSaved();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-base text-amber-300 hover:bg-amber-500/10"
      >
        <span className="inline-flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Manual token entry (advanced)
        </span>
        <AlertTriangle className="h-4 w-4" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-amber-500/20 px-3 py-3 text-base">
          <p className="text-sm text-amber-200/80">
            <strong>Temporary workaround.</strong> Paste Schwab <code>access_token</code> and{" "}
            <code>refresh_token</code> obtained out-of-band. Tokens are written directly to Supabase and
            the OAuth flow is bypassed. Use only while the registered Schwab callback URL is pending.
            Remove this section once OAuth works.
          </p>
          <label className="block">
            <span className="mb-1 block text-sm text-muted-foreground">access_token</span>
            <textarea
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
              placeholder="Paste Schwab access_token…"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted-foreground">refresh_token</span>
            <textarea
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
              placeholder="Paste Schwab refresh_token…"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={save}
              disabled={busy || !accessToken.trim() || !refreshToken.trim()}
            >
              {busy ? "Saving…" : "Save tokens"}
            </Button>
            {message && (
              <span
                className={
                  message.kind === "ok"
                    ? "text-sm text-emerald-300"
                    : "text-sm text-rose-300"
                }
              >
                {message.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Polygon bulk backfill — drains all earnings_history rows missing
// implied_move_pct via /api/screener/backfill-em-polygon. Loops the
// route in 5-event batches with no inter-event sleeps (paid Polygon
// tier handles parallel calls; the per-event wall-clock drops from
// ~40s on free tier to ~3-5s on paid). Exits when the server reports
// totalRemaining===0 or when a batch makes zero net progress.
type BulkOutcome = {
  symbol: string;
  earningsDate: string;
  status: "populated" | "skipped" | "error";
  reason?: string;
  emPct?: number;
  strike?: number;
};
type BulkBackfillResponse = {
  processed: number;
  populated: number;
  skipped: number;
  errored: number;
  totalRemainingAtStart: number;
  totalRemaining: number;
  outcomes: BulkOutcome[];
  error?: string;
};

function PolygonBulkBackfill() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [populatedCount, setPopulatedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [recent, setRecent] = useState<BulkOutcome[]>([]);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErrMsg(null);
    setStoppedReason(null);
    setDone(0);
    setPopulatedCount(0);
    setSkippedCount(0);
    setErrorCount(0);
    setRecent([]);
    setTotal(null);

    let firstTotal: number | null = null;
    let lastRemaining = Number.POSITIVE_INFINITY;
    // Hard cap so a stuck loop doesn't run forever (50 batches × 5
    // events ≈ 250 events ≈ ~25 minutes of wall-clock at paid-tier
    // pacing). Re-click to continue if there's still more to do.
    for (let i = 0; i < 50; i += 1) {
      let res: Response;
      try {
        res = await fetch("/api/screener/backfill-em-polygon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          cache: "no-store",
        });
      } catch (e) {
        setErrMsg(`Network error: ${e instanceof Error ? e.message : "unknown"}`);
        setRunning(false);
        return;
      }
      const json = (await res.json().catch(() => ({}))) as BulkBackfillResponse;
      if (!res.ok || json.error) {
        setErrMsg(json.error ?? `HTTP ${res.status}`);
        setRunning(false);
        return;
      }
      if (firstTotal === null) {
        firstTotal = json.totalRemainingAtStart;
        setTotal(firstTotal);
      }
      setPopulatedCount((prev) => prev + json.populated);
      setSkippedCount((prev) => prev + json.skipped);
      setErrorCount((prev) => prev + json.errored);
      setRecent((prev) => [...json.outcomes, ...prev].slice(0, 20));
      setDone((firstTotal ?? json.totalRemainingAtStart) - json.totalRemaining);

      if (json.totalRemaining === 0) {
        setStoppedReason("All historical rows backfilled.");
        setRunning(false);
        return;
      }
      if (json.totalRemaining >= lastRemaining) {
        setStoppedReason(
          `No progress in last batch (${json.skipped} skipped, ${json.errored} errored). ${json.totalRemaining} rows remain — re-run after fixing the underlying skips.`,
        );
        setRunning(false);
        return;
      }
      lastRemaining = json.totalRemaining;
    }
    setStoppedReason("Hit the 50-batch safety cap. Click again to continue.");
    setRunning(false);
  }

  const pct =
    total !== null && total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="space-y-3 text-base">
      <p className="text-muted-foreground">
        <strong className="text-foreground">Polygon bulk backfill.</strong>{" "}
        Drains every <code>earnings_history</code> row with{" "}
        <code>actual_move_pct</code> populated but{" "}
        <code>implied_move_pct</code> missing, using Polygon historical
        aggregates. Most-recent earnings first. Run while the Polygon
        subscription is active — Schwab can&apos;t fill historical EMs.
      </p>
      <Button size="sm" onClick={run} disabled={running}>
        {running ? `Backfilling… ${done}${total !== null ? ` / ${total}` : ""}` : "Backfill historical EM (Polygon)"}
      </Button>
      {total !== null && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">
              {done} / {total} processed
              {total > 0 && <span className="ml-2 font-mono">({pct}%)</span>}
            </span>
            <span className="font-mono text-sm">
              <span className="text-emerald-300">✓ {populatedCount}</span>{" "}
              <span className="text-amber-300">· {skippedCount} skipped</span>
              {errorCount > 0 && (
                <span className="text-rose-300"> · {errorCount} errored</span>
              )}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-emerald-500/20">
            <div
              className="h-full bg-emerald-400/70 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {stoppedReason && (
        <div className="rounded border border-border bg-background/40 p-2 text-sm text-muted-foreground">
          {stoppedReason}
        </div>
      )}
      {errMsg && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
          {errMsg}
        </div>
      )}
      {recent.length > 0 && (
        <details className="rounded border border-border bg-background/40 text-sm">
          <summary className="cursor-pointer px-2 py-1 text-muted-foreground hover:text-foreground">
            Recent outcomes (last {recent.length})
          </summary>
          <ul className="space-y-0.5 px-2 py-1 font-mono text-[11px]">
            {recent.map((o, idx) => (
              <li
                key={`${o.symbol}-${o.earningsDate}-${idx}`}
                className={
                  o.status === "populated"
                    ? "text-emerald-300/90"
                    : o.status === "error"
                      ? "text-rose-300/90"
                      : "text-amber-300/80"
                }
              >
                {o.symbol.padEnd(6)} {o.earningsDate}{" "}
                {o.status === "populated"
                  ? `EM=${(o.emPct! * 100).toFixed(2)}% @$${o.strike}`
                  : o.status === "error"
                    ? `error: ${o.reason}`
                    : `skip: ${o.reason}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Calls /api/encyclopedia/backfill-em which processes up to 40 rows
// per request inside the 60s Hobby ceiling. Re-clicking continues
// against the remaining null rows.
type BackfillResponse = {
  scanned: number;
  updated: number;
  skippedNoData: number;
  skippedLowConfidence: number;
  skippedImplausible: number;
  errors: string[];
  firstSymbol: string | null;
  lastSymbol: string | null;
};

function ImpliedMoveBackfill() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<BackfillResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/encyclopedia/backfill-em", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxBackfills: 40 }),
        cache: "no-store",
      });
      const json = (await res.json()) as BackfillResponse | { error?: string };
      if (!res.ok) {
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setLast(json as BackfillResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-base">
      <p className="text-muted-foreground">
        Backfills the <code>implied_move_pct</code> column on
        <code className="mx-1">earnings_history</code> rows that are
        missing it. Each row sends one Perplexity query and records the
        value only when confidence is high or medium and the result is
        between 5–25%. Processes up to 40 rows per click; re-run to
        continue.
      </p>
      <Button size="sm" onClick={run} disabled={busy}>
        {busy ? "Running…" : "Backfill historical implied moves"}
      </Button>
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
          {error}
        </div>
      )}
      {last && (
        <div className="rounded border border-border bg-background/40 p-2 text-sm">
          <div className="font-mono text-muted-foreground">
            scanned={last.scanned} · updated={last.updated} · skipped
            no-data={last.skippedNoData} · low-confidence=
            {last.skippedLowConfidence} · implausible={last.skippedImplausible}
          </div>
          {last.errors.length > 0 && (
            <div className="mt-1 text-rose-300">
              {last.errors.length} error
              {last.errors.length === 1 ? "" : "s"}: {last.errors.slice(0, 3).join("; ")}
              {last.errors.length > 3 && ` (+${last.errors.length - 3} more)`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Calls /api/encyclopedia/rekey-symbol for a single ticker. Phase 2C
// re-key only runs automatically on stale or never-pulled symbols;
// recently-touched symbols never get their legacy quarter-end rows
// cleaned up by maintenance, so this manual button covers that case.
type RekeyChange = {
  oldDate: string;
  newDate: string;
  action: "update" | "merge" | "unmatched";
  hour: "bmo" | "amc" | "dmh" | null;
};
type RekeyResponse = {
  rekey: {
    symbol: string;
    reingested: number;
    merged_with_existing: number;
    unmatched_rows: Array<{ oldDate: string; reason: string }>;
    already_clean: boolean;
    dryRun: boolean;
    changes: RekeyChange[];
  };
  summary: {
    symbol: string;
    newRecords: number;
    updatedRecords: number;
    isComplete: boolean;
  };
};

function RekeySymbol() {
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<RekeyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/encyclopedia/rekey-symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s }),
        cache: "no-store",
      });
      const json = (await res.json()) as RekeyResponse | { error?: string };
      if (!res.ok) {
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setLast(json as RekeyResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-key failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3 text-base">
      <p className="text-muted-foreground">
        Manually re-keys earnings_history rows from fiscal-quarter end to
        the actual announcement date and re-fetches price action with
        BMO/AMC timing. Use this when a symbol&apos;s recent rows still
        show implausibly small moves (e.g. 0.3%) after the auto-fix.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g. SPOT)"
          className="w-32 rounded border border-border bg-background px-2 py-1 font-mono text-sm uppercase"
        />
        <Button size="sm" onClick={run} disabled={busy || !symbol.trim()}>
          {busy ? "Running…" : "Re-key earnings history"}
        </Button>
      </div>
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
          {error}
        </div>
      )}
      {last && (
        <div className="rounded border border-border bg-background/40 p-2 text-sm">
          <div className="font-mono text-muted-foreground">
            {last.rekey.symbol} · rekeyed={last.rekey.reingested} · merged=
            {last.rekey.merged_with_existing} · unmatched=
            {last.rekey.unmatched_rows.length} · already-clean=
            {String(last.rekey.already_clean)}
          </div>
          {last.rekey.changes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px]">
              {last.rekey.changes.slice(0, 8).map((c, i) => (
                <li key={i} className="font-mono">
                  <span className="text-muted-foreground">{c.oldDate}</span>{" "}
                  →{" "}
                  <span className="text-foreground">{c.newDate}</span>{" "}
                  <span className="text-muted-foreground/70">
                    ({c.hour ?? "?"}, {c.action})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
