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

// 14-period Average True Range via Wilder smoothing — the standard
// volatility measure for setting a stop that's wide enough to survive
// this symbol's normal daily noise instead of a flat percentage that's
// too tight for a wild name and too loose for a calm one.
//   bars: daily OHLC, OLDEST FIRST. Needs >= period+1 bars (one prior
//   close to seed the first true range).
export function computeATR(
  bars: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number | null {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    ) {
      continue;
    }
    trueRanges.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
    );
  }
  if (trueRanges.length < period) return null;

  // Seed with a simple average of the first `period` true ranges, then
  // Wilder-smooth the rest — same shape as computeRSI above.
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

// Exponential moving average series aligned 1:1 with `values`
// (OLDEST FIRST). Indices before `period` values are available are
// `null`. Seeded with the SMA of the first `period` values (standard
// EMA warm-up), then the usual multiplier k = 2/(period+1) forward —
// NOT Wilder smoothing (that's a different, slower-decaying average;
// MACD is conventionally built on the standard EMA).
function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (!Array.isArray(values) || period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i += 1) {
    const cur = values[i] * k + prev * (1 - k);
    out[i] = cur;
    prev = cur;
  }
  return out;
}

export type MACDPoint = { macd: number; signal: number; histogram: number };

// Standard 12/26/9 MACD: fast EMA - slow EMA = MACD line, signal = EMA
// of the MACD line, histogram = MACD - signal.
//   closes: closing prices, OLDEST FIRST — the same array computeRSI/
//   computeSMA take, no separate fetch.
// Returns null if there isn't enough history for the slow EMA + signal
// EMA to both settle (needs >= slowPeriod + signalPeriod closes, with
// real-world margin for a stable read). `series` is oldest-first and
// only spans the range where MACD+signal are both defined — a caller
// wanting "last N days" should `.slice(-N)`.
export function computeMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { latest: MACDPoint; series: MACDPoint[] } | null {
  if (!Array.isArray(closes) || closes.length < slowPeriod + signalPeriod) {
    return null;
  }
  const fastEma = emaSeries(closes, fastPeriod);
  const slowEma = emaSeries(closes, slowPeriod);

  // MACD line is defined wherever both EMAs are (from slowPeriod-1
  // onward, since slow is the longer period) — collect it as its own
  // dense array so it can be fed into emaSeries again for the signal.
  const macdLine: number[] = [];
  for (let i = slowPeriod - 1; i < closes.length; i += 1) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f === null || s === null) continue;
    macdLine.push(f - s);
  }
  if (macdLine.length < signalPeriod) return null;

  const signalLine = emaSeries(macdLine, signalPeriod);
  const points: MACDPoint[] = [];
  for (let i = 0; i < macdLine.length; i += 1) {
    const sig = signalLine[i];
    if (sig === null) continue;
    points.push({ macd: macdLine[i], signal: sig, histogram: macdLine[i] - sig });
  }
  if (points.length === 0) return null;
  return { latest: points[points.length - 1], series: points };
}
