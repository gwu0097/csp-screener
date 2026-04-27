import { EncyclopediaStockView } from "@/components/encyclopedia-stock-view";

export const dynamic = "force-dynamic";

export default function EncyclopediaSymbolPage({
  params,
}: {
  params: { symbol: string };
}) {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  return (
    <div className="container mx-auto max-w-6xl py-6">
      <EncyclopediaStockView symbol={symbol} />
    </div>
  );
}
