import type { Candle, CandleSeries } from '@binaryai/types';
import type { OhlcInput } from '@binaryai/indicators';

export interface SeriesView extends OhlcInput {
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly length: number;
}

/** Column-oriented view of a candle series, which is what the indicators want. */
export function toSeriesView(series: CandleSeries): SeriesView {
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  for (const candle of series.candles) {
    open.push(candle.open);
    high.push(candle.high);
    low.push(candle.low);
    close.push(candle.close);
  }
  return { open, high, low, close, length: close.length };
}

export function lastCandle(series: CandleSeries): Candle | null {
  return series.candles.at(-1) ?? null;
}
