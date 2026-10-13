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

// Content-box width of an element, tracked with ResizeObserver; null until
// first measured. For layout choices that depend on the space a component
// actually has (sidebar open/closed, iPad portrait/landscape) rather than
// the viewport — a container-query in JS.
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number | null] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
