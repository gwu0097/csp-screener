// Technical indicators computed from scratch (no external lib) so the
// snapshot cache doesn't depend on Yahoo for derived values.

// 14-period RSI via Wilder smoothing.
//   prices: closing prices, OLDEST FIRST.
//   Needs >= 2*period bars (period for the seed average + period more
//   for the smoothing to settle) — returns null below that.
export function computeRSI(prices: number[], period = 14): number | null {
  if (!Array.isArray(prices) || prices.length < period * 2) return null;

  // 1. Price changes between consecutive closes.
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    changes.push(prices[i] - prices[i - 1]);
  }
  if (changes.length < period) return null;

  // 2-4. Seed averages from the first `period` changes.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i += 1) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += -c;
  }
  avgGain /= period;
  avgLoss /= period;

  // 5. Wilder smoothing across the remaining changes.
  for (let i = period; i < changes.length; i += 1) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  // 6-7. RS → RSI. No losses over the window ⇒ RSI 100.
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Simple moving average of the last `period` closes. Null if there
// aren't enough bars.
export function computeSMA(prices: number[], period: number): number | null {
  if (!Array.isArray(prices) || period <= 0 || prices.length < period) {
    return null;
  }
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}
