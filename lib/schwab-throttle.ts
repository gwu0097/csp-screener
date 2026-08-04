// Shared token-bucket gate for local-only Schwab capture scripts.
// Schwab's limit (120 req/min) is enforced server-side — a client-side
// sleep-after-each-call pattern under concurrency>1 can still burst
// past it, since multiple in-flight requests can land in the same
// window. This gate serializes DISPATCH timing globally across
// however many concurrent workers call it, so the true outbound rate
// stays capped regardless of concurrency.
export function createThrottle(requestsPerSecond: number) {
  const intervalMs = 1000 / requestsPerSecond;
  let nextSlotAt = 0;
  return async function acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt = slot + intervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}
