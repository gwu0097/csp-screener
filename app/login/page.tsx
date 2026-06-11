"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const inviteToken = params?.get("invite") ?? null;
  const nextPath = params?.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (inviteToken && password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        inviteToken ? "/api/auth/accept-invite" : "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            inviteToken ? { token: inviteToken, password } : { email, password },
          ),
          cache: "no-store",
        },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      router.replace(nextPath.startsWith("/") ? nextPath : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-background/60 p-6"
      >
        <div>
          <div className="text-xl font-semibold">CSP Screener</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {inviteToken
              ? "Welcome — set a password to finish creating your account."
              : "Sign in to continue."}
          </div>
        </div>

        {!inviteToken && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Email</span>
            <input
              className={inputCls}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">
            {inviteToken ? "Choose a password (10+ characters)" : "Password"}
          </span>
          <input
            className={inputCls}
            type="password"
            autoComplete={inviteToken ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={Boolean(inviteToken)}
          />
        </label>
        {inviteToken && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Confirm password</span>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}

        {error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {inviteToken ? "Creating account…" : "Signing in…"}
            </>
          ) : inviteToken ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
