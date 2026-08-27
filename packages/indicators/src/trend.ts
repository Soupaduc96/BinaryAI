import { assertPeriod, at, filled, type IndicatorSeries } from './internal.js';
import { assertSameLength, trueRange, type OhlcInput } from './volatility.js';

export interface AdxResult {
  /** Trend strength, 0..100. Wilder: >25 trending, <20 ranging. */
  readonly adx: IndicatorSeries;
  readonly plusDi: IndicatorSeries;
  readonly minusDi: IndicatorSeries;
}

/**
 * Wilder's ADX / DMI.
 *
 * Index alignment, spelled out because it is easy to get wrong:
 *   - +DM/-DM/TR exist from index 1 (they need a previous bar).
 *   - The Wilder sums seed at index `period`, so +DI/-DI/DX start there.
 *   - ADX seeds on the average of the first `period` DX values, so the first
 *     ADX lands at index `2 * period - 1`.
 */
export function adx(input: OhlcInput, period = 14): AdxResult {
  assertPeriod(period);
  const length = assertSameLength(input);

  const result: AdxResult = {
    adx: filled(length),
    plusDi: filled(length),
    minusDi: filled(length),
  };
  if (length <= period * 2) return result;

  const tr = trueRange(input);
  const plusDm = new Array<number>(length).fill(0);
  const minusDm = new Array<number>(length).fill(0);

  for (let i = 1; i < length; i += 1) {
    const upMove = at(input.high, i) - at(input.high, i - 1);
    const downMove = at(input.low, i - 1) - at(input.low, i);
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder's running sums (not averages) over indices 1..period.
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const trValue = tr[i];
    if (trValue === null || trValue === undefined) return result;
    trSum += trValue;
    plusSum += at(plusDm, i);
    minusSum += at(minusDm, i);
  }

  const dx = filled(length);
  const writeDi = (index: number): void => {
    const plusDi = trSum === 0 ? 0 : (100 * plusSum) / trSum;
    const minusDi = trSum === 0 ? 0 : (100 * minusSum) / trSum;
    result.plusDi[index] = plusDi;
    result.minusDi[index] = minusDi;
    const diSum = plusDi + minusDi;
    dx[index] = diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum;
  };

  writeDi(period);

  for (let i = period + 1; i < length; i += 1) {
    const trValue = tr[i];
    if (trValue === null || trValue === undefined) return result;
    trSum = trSum - trSum / period + trValue;
    plusSum = plusSum - plusSum / period + at(plusDm, i);
    minusSum = minusSum - minusSum / period + at(minusDm, i);
    writeDi(i);
  }

  // Seed ADX with the mean of the first `period` DX values.
  const seedIndex = period * 2 - 1;
  let dxSum = 0;
  for (let i = period; i <= seedIndex; i += 1) {
    const dxValue = dx[i];
    if (dxValue === null || dxValue === undefined) return result;
    dxSum += dxValue;
  }
  let previousAdx = dxSum / period;
  result.adx[seedIndex] = previousAdx;

  for (let i = seedIndex + 1; i < length; i += 1) {
    const dxValue = dx[i];
    if (dxValue === null || dxValue === undefined) return result;
    previousAdx = (previousAdx * (period - 1) + dxValue) / period;
    result.adx[i] = previousAdx;
  }

  return result;
}
