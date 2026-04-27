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

      {schwabFlash === "connected" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-sm text-emerald-300">
          Schwab connected successfully.
        </div>
      )}
      {schwabFlash === "error" && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
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
          <div className="text-sm text-muted-foreground">
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
        <CardContent>
          <ImpliedMoveBackfill />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment variables</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-sm">
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
          <p className="mt-3 text-xs text-muted-foreground">
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
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-amber-300 hover:bg-amber-500/10"
      >
        <span className="inline-flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Manual token entry (advanced)
        </span>
        <AlertTriangle className="h-4 w-4" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-amber-500/20 px-3 py-3 text-sm">
          <p className="text-xs text-amber-200/80">
            <strong>Temporary workaround.</strong> Paste Schwab <code>access_token</code> and{" "}
            <code>refresh_token</code> obtained out-of-band. Tokens are written directly to Supabase and
            the OAuth flow is bypassed. Use only while the registered Schwab callback URL is pending.
            Remove this section once OAuth works.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">access_token</span>
            <textarea
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
              placeholder="Paste Schwab access_token…"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">refresh_token</span>
            <textarea
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
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
                    ? "text-xs text-emerald-300"
                    : "text-xs text-rose-300"
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
    <div className="space-y-3 text-sm">
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
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
          {error}
        </div>
      )}
      {last && (
        <div className="rounded border border-border bg-background/40 p-2 text-xs">
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
