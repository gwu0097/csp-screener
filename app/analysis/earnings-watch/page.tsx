import { Suspense } from "react";
import { EarningsWatchView } from "@/components/earnings-watch-view";

export const dynamic = "force-dynamic";

export default function EarningsWatchPage() {
  return (
    <Suspense>
      <EarningsWatchView />
    </Suspense>
  );
}
