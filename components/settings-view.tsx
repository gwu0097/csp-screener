"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, X } from "lucide-react";

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
