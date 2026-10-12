"use client";

import { useEffect, useState } from "react";

// Below Tailwind's md breakpoint (768px). null until mounted — the server
// render and first client paint can't know the viewport, so callers that
// choose between two different trees (cards vs table) should render
// neither while it's null rather than flash the wrong one.
export const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}
