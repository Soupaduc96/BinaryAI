import { adx, atr, ema, lastValue, linearSlope, rsi } from '@binaryai/indicators';
import { toSeriesView } from '@binaryai/strategies';
import type {
  CandleSeries,
  MarketRegime,
  RegimeAssessment,
  VolatilityAssessment,
  VolatilityLevel,
} from '@binaryai/types';
import { clamp, clamp01, normalizeRange, round, safeDivide } from '@binaryai/utils';

/**
 * Rule-based market-regime classification.
 *
 * This is NOT machine learning. It is a transparent set of thresholds over ADX,
 * ATR and EMA slope, chosen from conventional technical-analysis practice. It
 * is labelled `rule_based` everywhere it surfaces, and it is the component most
 * likely to be replaced by a trained classifier later -- which is why the
 * result type (`RegimeAssessment`) is independent of how it was produced.
 */

export interface RegimeOptions {
  readonly adxPeriod?: number;
  readonly atrPeriod?: number;
  readonly rsiPeriod?: number;
  readonly emaFastPeriod?: number;
  readonly emaSlowPeriod?: number;
  /** ADX at or above this counts as trending. */
  readonly trendThreshold?: number;
  /** ADX at or below this counts as ranging. */
  readonly rangeThreshold?: number;
  /** ATR% above this counts as volatile. */
  readonly volatileAtrPercent?: number;
  /** ATR% below this counts as quiet. */
  readonly quietAtrPercent?: number;
}

const UNKNOWN_REGIME: RegimeAssessment = {
  regime: 'unknown',
  clarity: 0,
  trendDirection: 'flat',
  trendStrength: 0,
  momentum: 0,
  volatility: { atr: null, atrPercent: null, level: 'normal' },
  metrics: {},
};

export function classifyRegime(
  series: CandleSeries,
  options: RegimeOptions = {},
): RegimeAssessment {
  const {
    adxPeriod = 14,
    atrPeriod = 14,
    rsiPeriod = 14,
    emaFastPeriod = 9,
    emaSlowPeriod = 21,
    trendThreshold = 25,
    rangeThreshold = 20,
    volatileAtrPercent = 1.5,
    quietAtrPercent = 0.05,
  } = options;

  const view = toSeriesView(series);
  if (view.length < Math.max(adxPeriod * 2 + 1, emaSlowPeriod, rsiPeriod + 1) + 2) {
    return UNKNOWN_REGIME;
  }

  const { adx: adxSeries, plusDi, minusDi } = adx(view, adxPeriod);
  const strength = lastValue(adxSeries);
  const plus = lastValue(plusDi);
  const minus = lastValue(minusDi);
  const range = lastValue(atr(view, atrPeriod));
  const momentumRsi = lastValue(rsi(view.close, rsiPeriod));
  const fast = lastValue(ema(view.close, emaFastPeriod));
  const slow = lastValue(ema(view.close, emaSlowPeriod));
  const slope = lastValue(linearSlope(view.close, emaFastPeriod));
  const price = view.close.at(-1) ?? null;

  if (strength === null || price === null || price <= 0) return UNKNOWN_REGIME;

  const atrPercent = range === null ? null : safeDivide(range, price) * 100;
  const volatility = assessVolatility(range, atrPercent, volatileAtrPercent, quietAtrPercent);

  const slopeBps = slope === null ? 0 : safeDivide(slope, price) * 10_000;
  const trendDirection = resolveDirection(fast, slow, slopeBps, plus, minus);
  const trendStrength = clamp01(normalizeRange(strength, rangeThreshold, 45));

  // Momentum blends RSI displacement with normalized slope, mapped to -1..1.
  const rsiComponent = momentumRsi === null ? 0 : clamp((momentumRsi - 50) / 30, -1, 1);
  const slopeComponent = clamp(slopeBps / 10, -1, 1);
  const momentum = clamp((rsiComponent * 2 + slopeComponent) / 3, -1, 1);

  const { regime, clarity } = resolveRegime({
    strength,
    trendThreshold,
    rangeThreshold,
    trendDirection,
    volatility,
    atrPercent,
    volatileAtrPercent,
  });

  return {
    regime,
    clarity: round(clarity, 4),
    trendDirection,
    trendStrength: round(trendStrength, 4),
    momentum: round(momentum, 4),
    volatility,
    metrics: {
      adx: strength === null ? null : round(strength, 4),
      plusDi: plus === null ? null : round(plus, 4),
      minusDi: minus === null ? null : round(minus, 4),
      rsi: momentumRsi === null ? null : round(momentumRsi, 4),
      emaFast: fast === null ? null : round(fast, 8),
      emaSlow: slow === null ? null : round(slow, 8),
      slopeBpsPerBar: round(slopeBps, 4),
      atrPercent: atrPercent === null ? null : round(atrPercent, 4),
    },
  };
}

function assessVolatility(
  range: number | null,
  atrPercent: number | null,
  volatileAtrPercent: number,
  quietAtrPercent: number,
): VolatilityAssessment {
  let level: VolatilityLevel = 'normal';
  if (atrPercent !== null) {
    if (atrPercent >= volatileAtrPercent * 2) level = 'extreme';
    else if (atrPercent >= volatileAtrPercent) level = 'high';
    else if (atrPercent <= quietAtrPercent) level = 'low';
  }
  return {
    atr: range === null ? null : round(range, 8),
    atrPercent: atrPercent === null ? null : round(atrPercent, 4),
    level,
  };
}

function resolveDirection(
  fast: number | null,
  slow: number | null,
  slopeBps: number,
  plus: number | null,
  minus: number | null,
): 'up' | 'down' | 'flat' {
  let score = 0;
  if (fast !== null && slow !== null) score += fast > slow ? 1 : fast < slow ? -1 : 0;
  if (plus !== null && minus !== null) score += plus > minus ? 1 : plus < minus ? -1 : 0;
  if (slopeBps > 0.5) score += 1;
  else if (slopeBps < -0.5) score -= 1;

  if (score >= 2) return 'up';
  if (score <= -2) return 'down';
  return 'flat';
}

interface RegimeResolution {
  readonly strength: number;
  readonly trendThreshold: number;
  readonly rangeThreshold: number;
  readonly trendDirection: 'up' | 'down' | 'flat';
  readonly volatility: VolatilityAssessment;
  readonly atrPercent: number | null;
  readonly volatileAtrPercent: number;
}

function resolveRegime(input: RegimeResolution): { regime: MarketRegime; clarity: number } {
  const { strength, trendThreshold, rangeThreshold, trendDirection, volatility } = input;

  if (volatility.level === 'extreme') {
    return { regime: 'volatile', clarity: 0.8 };
  }
  if (volatility.level === 'low' && strength < trendThreshold) {
    return { regime: 'quiet', clarity: 0.6 };
  }
  if (strength >= trendThreshold && trendDirection !== 'flat') {
    return {
      regime: trendDirection === 'up' ? 'trend_up' : 'trend_down',
      clarity: clamp01(normalizeRange(strength, trendThreshold, 45)),
    };
  }
  if (strength <= rangeThreshold) {
    return { regime: 'range', clarity: clamp01(normalizeRange(rangeThreshold - strength, 0, 12)) };
  }
  // Between the thresholds: genuinely ambiguous, and reported as such.
  return { regime: 'range', clarity: 0.25 };
}
