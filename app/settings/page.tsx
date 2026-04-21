import { isSchwabConnected } from "@/lib/schwab";
import { SettingsView } from "@/components/settings-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = { schwab?: string; reason?: string };

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { connected, lastRefresh } = await isSchwabConnected().catch(() => ({ connected: false, lastRefresh: null }));

  const envFlags = {
    SCHWAB_CLIENT_ID: Boolean(process.env.SCHWAB_CLIENT_ID),
    SCHWAB_CLIENT_SECRET: Boolean(process.env.SCHWAB_CLIENT_SECRET),
    SCHWAB_REDIRECT_URI: Boolean(process.env.SCHWAB_REDIRECT_URI),
    FINNHUB_API_KEY: Boolean(process.env.FINNHUB_API_KEY),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    NEXT_PUBLIC_APP_URL: Boolean(process.env.NEXT_PUBLIC_APP_URL),
  };

  return (
    <SettingsView
      connected={connected}
      lastRefresh={lastRefresh}
      envFlags={envFlags}
      schwabFlash={searchParams.schwab ?? null}
      schwabReason={searchParams.reason ?? null}
    />
  );
}
