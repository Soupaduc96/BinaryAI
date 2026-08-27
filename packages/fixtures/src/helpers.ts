import type { CandleSeries, MarketAsset } from '@binaryai/types';

export const defaultTestAsset: MarketAsset = {
  symbol: 'SYNTH',
  displayName: 'Synthetic Test Instrument',
  assetClass: 'unknown',
  pricePrecision: 5,
  isOtc: false,
};

/**
 * Slice a series to the first `endIndexInclusive + 1` candles.
 *
 * This is how the backtester feeds a strategy: the strategy literally cannot
 * see future bars, because they are not in the object it receives.
 */
export function seriesWindow(series: CandleSeries, endIndexInclusive: number): CandleSeries {
  return { ...series, candles: series.candles.slice(0, endIndexInclusive + 1) };
}
