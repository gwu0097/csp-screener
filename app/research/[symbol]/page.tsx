import { ResearchStockView } from "@/components/research-stock-view";

export const dynamic = "force-dynamic";

export default function ResearchStockPage({
  params,
}: {
  params: { symbol: string };
}) {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  return (
    <div className="space-y-4">
      <ResearchStockView symbol={symbol} />
    </div>
  );
}
