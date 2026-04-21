import { createServerClient, TradeRow } from "@/lib/supabase";
import { HistoryView } from "@/components/history-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HistoryPage() {
  let trades: TradeRow[] = [];
  let error: string | null = null;
  try {
    const supabase = createServerClient();
    const { data, error: err } = await supabase.from("trades").select("*").order("created_at", { ascending: false });
    if (err) throw err;
    trades = (data ?? []) as TradeRow[];
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load trades";
  }
  return <HistoryView trades={trades} error={error} />;
}
