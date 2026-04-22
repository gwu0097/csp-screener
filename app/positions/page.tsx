import { getMarketContext } from "@/lib/market";
import { PositionsView } from "@/components/positions-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PositionsPage() {
  const market = await getMarketContext();
  return <PositionsView market={market} />;
}
