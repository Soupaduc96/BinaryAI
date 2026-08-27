import { adx, atr, barsSinceCross, ema, linearSlope, lastValue, rsi } from '@binaryai/indicators';
import {
  TIMEFRAME_SECONDS,
  type Confirmation,
  type Conflict,
  type MarketRegime,
  type SignalDirection,
  type Strategy,
  type StrategyContext,
  type StrategyEvaluation,
  type StrategyParameterSpec,
} from '@binaryai/types';
import { normalizeRange, round, safeDivide } from '@binaryai/utils';
import { abstain, confirmation, conflict, snapshot } from './evidence.js';
import { integerParam, numberParam } from './parameters.js';
import { toSeriesView } from './series.js';

const ID = 'trend-momentum';
const VERSION = '1.0.0';

const PARAMETERS: readonly StrategyParameterSpec[] = [
  {
    key: 'emaFastPeriod',
    label: 'Fast EMA',
    type: 'number',
    defaultValue: 9,
    min: 2,
    max: 200,
    step: 1,
    description: 'Short-term trend reference.',
  },
  {
    key: 'emaSlowPeriod',
    label: 'Slow EMA',
    type: 'number',
    defaultValue: 21,
    min: 3,
    max: 400,
    step: 1,
    description: 'Long-term trend reference.',
  },
  {
    key: 'rsiPeriod',
    label: 'RSI period',
    type: 'number',
    defaultValue: 14,
    min: 2,
    max: 100,
    step: 1,
    description: 'Momentum lookback.',
  },
  {
    key: 'adxPeriod',
    label: 'ADX period',
    type: 'number',
    defaultValue: 14,
    min: 2,
    max: 100,
    step: 1,
    description: 'Trend-strength lookback.',
  },
  {
    key: 'atrPeriod',
    label: 'ATR period',
    type: 'number',
    defaultValue: 14,
    min: 2,
    max: 100,
    step: 1,
    description: 'Volatility lookback.',
  },
  {
    key: 'minAdx',
    label: 'Minimum ADX',
    type: 'number',
    defaultValue: 20,
    min: 0,
    max: 60,
    step: 1,
    description: 'Below this the trend is treated as too weak.',
  },
  {
    key: 'rsiBullThreshold',
    label: 'RSI bull threshold',
    type: 'number',
    defaultValue: 52,
    min: 50,
    max: 80,
    step: 1,
    description: 'RSI must exceed this for a CALL.',
  },
  {
    key: 'rsiBearThreshold',
    label: 'RSI bear threshold',
    type: 'number',
    defaultValue: 48,
    min: 20,
    max: 50,
    step: 1,
    description: 'RSI must fall below this for a PUT.',
  },
  {
    key: 'rsiExhaustion',
    label: 'RSI exhaustion',
    type: 'number',
    defaultValue: 78,
    min: 60,
    max: 95,
    step: 1,
    description: 'Beyond this (or its mirror) momentum is treated as stretched.',
  },
  {
    key: 'maxAtrPercent',
    label: 'Max ATR %',
    type: 'number',
    defaultValue: 1.5,
    min: 0.05,
    max: 20,
    step: 0.05,
    description: 'Volatility ceiling as a percentage of price.',
  },
  {
    key: 'expirationBars',
    label: 'Expiry (bars)',
    type: 'number',
    defaultValue: 3,
    min: 1,
    max: 60,
    step: 1,
    description: 'Suggested expiry, in candles.',
  },
];

function requiredHistoryFor(emaSlow: number, adxPeriod: number, rsiPeriod: number): number {
  return Math.max(emaSlow, adxPeriod * 2 + 1, rsiPeriod + 1) + 5;
}

/**
 * Trend + momentum continuation.
 *
 * Thesis: in a directional market with confirmed strength, short-dated
 * continuation is more likely than reversal. The strategy therefore requires
 * trend (EMA stack + ADX), momentum agreement (RSI) and acceptable volatility
 * (ATR) before it will name a direction.
 *
 * It is a rule-based model. It is not trained, not fitted and not optimised
 * against any dataset -- the numbers below are conventional defaults, and no
 * claim is made about their profitability.
 */
export const trendMomentumStrategy: Strategy = {
  meta: {
    id: ID,
    name: 'Trend Momentum',
    version: VERSION,
    description:
      'Follows an established trend when EMA alignment, ADX strength and RSI momentum agree, ' +
      'and flags exhaustion or excess volatility as conflicts.',
    requiredHistory: requiredHistoryFor(21, 14, 14),
    supportedTimeframes: 'any',
    tags: ['trend', 'momentum', 'continuation'],
  },
  parameters: PARAMETERS,

  evaluate(context: StrategyContext): StrategyEvaluation {
    const { series, timeframe, parameters } = context;
    const emaFastPeriod = integerParam(parameters, 'emaFastPeriod');
    const emaSlowPeriod = integerParam(parameters, 'emaSlowPeriod');
    const rsiPeriod = integerParam(parameters, 'rsiPeriod');
    const adxPeriod = integerParam(parameters, 'adxPeriod');
    const atrPeriod = integerParam(parameters, 'atrPeriod');
    const minAdx = numberParam(parameters, 'minAdx');
    const rsiBull = numberParam(parameters, 'rsiBullThreshold');
    const rsiBear = numberParam(parameters, 'rsiBearThreshold');
    const rsiExhaustion = numberParam(parameters, 'rsiExhaustion');
    const maxAtrPercent = numberParam(parameters, 'maxAtrPercent');
    const expirationBars = integerParam(parameters, 'expirationBars');

    const expirationSeconds = expirationBars * TIMEFRAME_SECONDS[timeframe];
    const view = toSeriesView(series);
    const required = requiredHistoryFor(emaSlowPeriod, adxPeriod, rsiPeriod);

    if (view.length < required) {
      return abstain(
        ID,
        VERSION,
        `insufficient history: ${view.length} candles, ${required} required`,
        expirationSeconds,
      );
    }

    const fastSeries = ema(view.close, emaFastPeriod);
    const slowSeries = ema(view.close, emaSlowPeriod);
    const rsiSeries = rsi(view.close, rsiPeriod);
    const { adx: adxSeries, plusDi, minusDi } = adx(view, adxPeriod);
    const atrSeries = atr(view, atrPeriod);
    const slopeSeries = linearSlope(view.close, emaFastPeriod);

    const price = view.close.at(-1) ?? null;
    const fast = lastValue(fastSeries);
    const slow = lastValue(slowSeries);
    const momentum = lastValue(rsiSeries);
    const strength = lastValue(adxSeries);
    const plus = lastValue(plusDi);
    const minus = lastValue(minusDi);
    const range = lastValue(atrSeries);
    const slope = lastValue(slopeSeries);

    const atrPercent = range !== null && price !== null ? safeDivide(range, price) * 100 : null;
    const slopeBps = slope !== null && price !== null ? safeDivide(slope, price) * 10_000 : null;

    const indicators = [
      snapshot('ema_fast', `EMA(${emaFastPeriod})`, fast, directionOf(fast, slow)),
      snapshot('ema_slow', `EMA(${emaSlowPeriod})`, slow, 'neutral'),
      snapshot('rsi', `RSI(${rsiPeriod})`, momentum, rsiInterpretation(momentum, rsiBull, rsiBear)),
      snapshot('adx', `ADX(${adxPeriod})`, strength, 'neutral', 'Trend strength, not direction.'),
      snapshot('plus_di', '+DI', plus, 'bullish'),
      snapshot('minus_di', '-DI', minus, 'bearish'),
      snapshot(
        'atr_percent',
        'ATR %',
        atrPercent,
        'neutral',
        'Volatility as a percentage of price.',
      ),
    ];

    if (
      price === null ||
      fast === null ||
      slow === null ||
      momentum === null ||
      strength === null
    ) {
      return abstain(
        ID,
        VERSION,
        'indicators not ready for this window',
        expirationSeconds,
        indicators,
      );
    }

    const bullish = fast > slow;
    const direction: SignalDirection =
      bullish && momentum > rsiBull ? 'call' : !bullish && momentum < rsiBear ? 'put' : 'none';

    const regimeHint = classifyRegime(strength, minAdx, plus, minus, atrPercent, maxAtrPercent);

    if (direction === 'none') {
      return {
        strategyId: ID,
        strategyVersion: VERSION,
        direction: 'none',
        indicators,
        confirmations: [],
        conflicts: [],
        regimeHint,
        expirationSeconds,
        notes: [
          `EMA stack is ${bullish ? 'bullish' : 'bearish'} but RSI (${round(momentum, 1)}) ` +
            `does not confirm (needs >${rsiBull} for CALL, <${rsiBear} for PUT).`,
        ],
        abstainReason: 'trend and momentum disagree',
      };
    }

    const isCall = direction === 'call';
    const separation = safeDivide(Math.abs(fast - slow), price) * 10_000;

    const confirmations: Confirmation[] = [
      confirmation(
        'ema_alignment',
        'EMA alignment',
        normalizeRange(separation, 1, 25),
        `EMA(${emaFastPeriod}) is ${isCall ? 'above' : 'below'} EMA(${emaSlowPeriod}) by ${round(separation, 1)} bps.`,
      ),
      confirmation(
        'trend_strength',
        'Trend strength',
        normalizeRange(strength, minAdx, 40),
        `ADX is ${round(strength, 1)} (threshold ${minAdx}).`,
      ),
      confirmation(
        'momentum',
        'Momentum',
        normalizeRange(Math.abs(momentum - 50), 2, 25),
        `RSI is ${round(momentum, 1)}, ${isCall ? 'above' : 'below'} the midline.`,
      ),
    ];

    if (plus !== null && minus !== null) {
      const dominance = isCall ? plus - minus : minus - plus;
      if (dominance > 0) {
        confirmations.push(
          confirmation(
            'di_dominance',
            'Directional dominance',
            normalizeRange(dominance, 3, 30),
            `${isCall ? '+DI' : '-DI'} leads by ${round(dominance, 1)}.`,
          ),
        );
      }
    }

    if (slopeBps !== null && (isCall ? slopeBps > 0 : slopeBps < 0)) {
      confirmations.push(
        confirmation(
          'price_slope',
          'Price slope',
          normalizeRange(Math.abs(slopeBps), 0.5, 12),
          `Regression slope is ${round(slopeBps, 2)} bps/bar.`,
        ),
      );
    }

    const cross = barsSinceCross(fastSeries, slowSeries, 8);
    if (
      cross &&
      ((isCall && cross.direction === 'above') || (!isCall && cross.direction === 'below'))
    ) {
      confirmations.push(
        confirmation(
          'recent_cross',
          'Recent EMA cross',
          normalizeRange(8 - cross.barsAgo, 0, 8),
          `EMA cross in this direction ${cross.barsAgo} bar(s) ago.`,
        ),
      );
    }

    const conflicts: Conflict[] = [];

    if (strength < minAdx) {
      conflicts.push(
        conflict(
          'weak_trend',
          'Weak trend',
          normalizeRange(minAdx - strength, 0, minAdx),
          'major',
          `ADX ${round(strength, 1)} is below the ${minAdx} threshold; continuation is unreliable.`,
        ),
      );
    }

    const stretched = isCall ? momentum >= rsiExhaustion : momentum <= 100 - rsiExhaustion;
    if (stretched) {
      conflicts.push(
        conflict(
          'momentum_exhaustion',
          'Momentum exhaustion',
          normalizeRange(Math.abs(momentum - 50), 25, 45),
          'minor',
          `RSI ${round(momentum, 1)} is stretched; a pullback is plausible.`,
        ),
      );
    }

    if (atrPercent !== null && atrPercent > maxAtrPercent) {
      conflicts.push(
        conflict(
          'high_volatility',
          'Elevated volatility',
          normalizeRange(atrPercent - maxAtrPercent, 0, maxAtrPercent),
          'major',
          `ATR is ${round(atrPercent, 2)}% of price, above the ${maxAtrPercent}% ceiling.`,
        ),
      );
    }

    if (plus !== null && minus !== null && (isCall ? minus > plus : plus > minus)) {
      conflicts.push(
        conflict(
          'di_contradiction',
          'Directional index disagrees',
          normalizeRange(Math.abs(plus - minus), 1, 20),
          'major',
          'The dominant directional index points against the candidate direction.',
        ),
      );
    }

    if (slopeBps !== null && (isCall ? slopeBps < 0 : slopeBps > 0)) {
      conflicts.push(
        conflict(
          'slope_contradiction',
          'Slope disagrees',
          normalizeRange(Math.abs(slopeBps), 0.5, 12),
          'minor',
          `Short-term slope is ${round(slopeBps, 2)} bps/bar, against the candidate direction.`,
        ),
      );
    }

    return {
      strategyId: ID,
      strategyVersion: VERSION,
      direction,
      indicators,
      confirmations,
      conflicts,
      regimeHint,
      expirationSeconds,
      notes: [
        `Trend ${isCall ? 'up' : 'down'} with ADX ${round(strength, 1)} and RSI ${round(momentum, 1)}.`,
        `Suggested expiry ${expirationBars} bar(s) = ${expirationSeconds}s.`,
      ],
    };
  },
};

function directionOf(fast: number | null, slow: number | null): 'bullish' | 'bearish' | 'neutral' {
  if (fast === null || slow === null) return 'neutral';
  if (fast > slow) return 'bullish';
  if (fast < slow) return 'bearish';
  return 'neutral';
}

function rsiInterpretation(
  value: number | null,
  bull: number,
  bear: number,
): 'bullish' | 'bearish' | 'neutral' {
  if (value === null) return 'neutral';
  if (value > bull) return 'bullish';
  if (value < bear) return 'bearish';
  return 'neutral';
}

function classifyRegime(
  strength: number,
  minAdx: number,
  plus: number | null,
  minus: number | null,
  atrPercent: number | null,
  maxAtrPercent: number,
): MarketRegime {
  if (atrPercent !== null && atrPercent > maxAtrPercent * 1.5) return 'volatile';
  if (strength < minAdx) return 'range';
  if (plus === null || minus === null) return 'unknown';
  return plus >= minus ? 'trend_up' : 'trend_down';
}
