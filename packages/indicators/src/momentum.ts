import { assertPeriod, at, filled, type IndicatorSeries } from './internal.js';
import { ema } from './moving-averages.js';

/**
 * Wilder's RSI. First value lands at index `period` (one change per bar means
 * the first `period` changes span indices 1..period).
 *
 * Edge cases follow the standard definition: an all-gains window is 100, an
 * all-losses window is 0.
 */
export function rsi(values: readonly number[], period = 14): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = at(values, i) - at(values, i - 1);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  out[period] = rsiFrom(averageGain, averageLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = at(values, i) - at(values, i - 1);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(averageGain, averageLoss);
  }
  return out;
}

function rsiFrom(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export interface MacdResult {
  readonly macd: IndicatorSeries;
  readonly signal: IndicatorSeries;
  readonly histogram: IndicatorSeries;
}

/**
 * MACD. The signal line is an EMA of the MACD line, which only exists from the
 * slow EMA onwards -- so it is computed on the compacted MACD values and
 * mapped back to the original indices. Getting this offset wrong is a common
 * bug; the compaction makes it explicit.
 */
export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  assertPeriod(fastPeriod, 'fastPeriod');
  assertPeriod(slowPeriod, 'slowPeriod');
  assertPeriod(signalPeriod, 'signalPeriod');
  if (fastPeriod >= slowPeriod) {
    throw new Error(`fastPeriod (${fastPeriod}) must be smaller than slowPeriod (${slowPeriod})`);
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine = filled(values.length);
  const compact: number[] = [];
  let firstIndex = -1;

  for (let i = 0; i < values.length; i += 1) {
    const fastValue = fast[i];
    const slowValue = slow[i];
    if (fastValue === null || fastValue === undefined) continue;
    if (slowValue === null || slowValue === undefined) continue;
    const value = fastValue - slowValue;
    macdLine[i] = value;
    if (firstIndex === -1) firstIndex = i;
    compact.push(value);
  }

  const signalLine = filled(values.length);
  const histogram = filled(values.length);
  if (firstIndex === -1) return { macd: macdLine, signal: signalLine, histogram };

  const compactSignal = ema(compact, signalPeriod);
  for (let k = 0; k < compactSignal.length; k += 1) {
    const signalValue = compactSignal[k];
    if (signalValue === null || signalValue === undefined) continue;
    const index = firstIndex + k;
    signalLine[index] = signalValue;
    const macdValue = macdLine[index];
    if (macdValue !== null && macdValue !== undefined) {
      histogram[index] = macdValue - signalValue;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}
