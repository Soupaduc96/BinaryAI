import { TIMEFRAME_SECONDS, type Candle, type CandleSeries, type Timeframe } from '@binaryai/types';
import { createSeededRandom } from '@binaryai/utils';

/**
 * SYNTHETIC DATA -- NOT MARKET DATA.
 *
 * This package exists so that generated candles can never be mistaken for real
 * ones. Every series it returns carries `source: 'synthetic'` and a label that
 * says so, and no runtime path (API, web, engine) depends on this package --
 * only tests, benchmarks and the demo backtest script do.
 *
 * A random walk is not a market. Results produced from it say something about
 * the *engine*, and nothing whatsoever about a strategy's real edge.
 */

export interface SyntheticSeriesOptions {
  readonly asset?: string;
  readonly timeframe?: Timeframe;
  readonly count: number;
  readonly startPrice?: number;
  readonly startTimestamp?: number;
  readonly seed?: number;
  /** Mean per-bar return, as a fraction (0.0005 = +0.05% per bar). */
  readonly drift?: number;
  /** Per-bar return standard deviation, as a fraction. */
  readonly volatility?: number;
  /** Wick size as a fraction of price. */
  readonly wick?: number;
  /** Leave the final candle open, to exercise incomplete-candle handling. */
  readonly lastCandleIncomplete?: boolean;
}

export function createSyntheticSeries(options: SyntheticSeriesOptions): CandleSeries {
  const {
    asset = 'SYNTH',
    timeframe = '1m',
    count,
    startPrice = 100,
    startTimestamp = Date.UTC(2026, 0, 1, 0, 0, 0),
    seed = 42,
    drift = 0,
    volatility = 0.001,
    wick = 0.0004,
    lastCandleIncomplete = false,
  } = options;

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer, received ${count}`);
  }

  const random = createSeededRandom(seed);
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const candles: Candle[] = [];

  let previousClose = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = previousClose;
    const shock = random.nextNormal();
    const close = Math.max(open * (1 + drift + volatility * shock), 1e-8);
    const upperWick = Math.abs(random.nextNormal()) * wick;
    const lowerWick = Math.abs(random.nextNormal()) * wick;
    const high = Math.max(open, close) * (1 + upperWick);
    const low = Math.max(Math.min(open, close) * (1 - lowerWick), 1e-9);

    candles.push({
      timestamp: startTimestamp + i * stepMs,
      open,
      high,
      low,
      close,
      volume: null,
      complete: !(lastCandleIncomplete && i === count - 1),
    });
    previousClose = close;
  }

  return {
    asset,
    timeframe,
    source: 'synthetic',
    label: `synthetic:seed=${seed} (NOT MARKET DATA)`,
    candles,
  };
}

/** A clean, low-noise uptrend. Useful for asserting trend-following behaviour. */
export function syntheticUptrend(count = 200, seed = 7): CandleSeries {
  return createSyntheticSeries({ count, seed, drift: 0.0012, volatility: 0.0004, wick: 0.0002 });
}

/** A clean downtrend. */
export function syntheticDowntrend(count = 200, seed = 11): CandleSeries {
  return createSyntheticSeries({ count, seed, drift: -0.0012, volatility: 0.0004, wick: 0.0002 });
}

/** Sideways chop with no drift. */
export function syntheticRange(count = 200, seed = 13): CandleSeries {
  return createSyntheticSeries({ count, seed, drift: 0, volatility: 0.0006, wick: 0.0006 });
}

/** High-volatility noise, for exercising the volatility filters. */
export function syntheticVolatile(count = 200, seed = 17): CandleSeries {
  return createSyntheticSeries({ count, seed, drift: 0, volatility: 0.006, wick: 0.004 });
}
