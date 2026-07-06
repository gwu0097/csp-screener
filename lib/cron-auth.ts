// Bearer-secret gate for machine-called cron endpoints. These routes
// are on the middleware public allowlist (no session cookie), so this
// check is their ONLY protection — fail closed when the secret is
// missing from the environment.
import { NextRequest, NextResponse } from "next/server";

export function requireCronSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 32) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
