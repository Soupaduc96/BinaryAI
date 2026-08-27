import { adx, atr, bollingerBands, lastValue, rsi } from '@binaryai/indicators';
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

const ID = 'mean-reversion';
const VERSION = '1.0.0';

const PARAMETERS: readonly StrategyParameterSpec[] = [
  {
    key: 'bandPeriod',
    label: 'Band period',
    type: 'number',
    defaultValue: 20,
    min: 5,
    max: 200,
    step: 1,
    description: 'Bollinger Band lookback.',
  },
  {
    key: 'bandMultiplier',
    label: 'Band width',
    type: 'number',
    defaultValue: 2,
    min: 0.5,
    max: 5,
    step: 0.1,
    description: 'Standard deviations for the bands.',
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
    key: 'rsiOversold',
    label: 'RSI oversold',
    type: 'number',
    defaultValue: 30,
    min: 5,
    max: 45,
    step: 1,
    description: 'Below this, price is treated as stretched down.',
  },
  {
    key: 'rsiOverbought',
    label: 'RSI overbought',
    type: 'number',
    defaultValue: 70,
    min: 55,
    max: 95,
    step: 1,
    description: 'Above this, price is treated as stretched up.',
  },
  {
    key: 'maxAdx',
    label: 'Max ADX',
    type: 'number',
    defaultValue: 22,
    min: 5,
    max: 60,
    step: 1,
    description: 'Above this the market is trending and reversion is unreliable.',
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

function requiredHistoryFor(bandPeriod: number, adxPeriod: number, rsiPeriod: number): number {
  return Math.max(bandPeriod, adxPeriod * 2 + 1, rsiPeriod + 1) + 5;
}

/**
 * Range mean-reversion.
 *
 * Thesis: inside a range, a stretch outside a Bollinger Band with an RSI
 * extreme tends to snap back toward the mean. The strategy explicitly refuses
 * to fight a trending market -- a high ADX becomes a blocking conflict, which
 * is the single most important guard on this family of setups.
 *
 * Rule-based. Not fitted to any dataset; no profitability claim is made.
 */
export const meanReversionStrategy: Strategy = {
  meta: {
    id: ID,
    name: 'Range Mean Reversion',
    version: VERSION,
    description:
      'Fades stretched moves back toward the mean inside a range, and stands down when the ' +
      'market is trending or volatility is elevated.',
    requiredHistory: requiredHistoryFor(20, 14, 14),
    supportedTimeframes: 'any',
    tags: ['mean-reversion', 'range', 'counter-trend'],
  },
  parameters: PARAMETERS,

  evaluate(context: StrategyContext): StrategyEvaluation {
    const { series, timeframe, parameters } = context;
    const bandPeriod = integerParam(parameters, 'bandPeriod');
    const bandMultiplier = numberParam(parameters, 'bandMultiplier');
    const rsiPeriod = integerParam(parameters, 'rsiPeriod');
    const rsiOversold = numberParam(parameters, 'rsiOversold');
    const rsiOverbought = numberParam(parameters, 'rsiOverbought');
    const maxAdx = numberParam(parameters, 'maxAdx');
    const adxPeriod = integerParam(parameters, 'adxPeriod');
    const atrPeriod = integerParam(parameters, 'atrPeriod');
    const maxAtrPercent = numberParam(parameters, 'maxAtrPercent');
    const expirationBars = integerParam(parameters, 'expirationBars');

    const expirationSeconds = expirationBars * TIMEFRAME_SECONDS[timeframe];
    const view = toSeriesView(series);
    const required = requiredHistoryFor(bandPeriod, adxPeriod, rsiPeriod);

    if (view.length < required) {
      return abstain(
        ID,
        VERSION,
        `insufficient history: ${view.length} candles, ${required} required`,
        expirationSeconds,
      );
    }

    const bands = bollingerBands(view.close, bandPeriod, bandMultiplier);
    const rsiSeries = rsi(view.close, rsiPeriod);
    const { adx: adxSeries } = adx(view, adxPeriod);
    const atrSeries = atr(view, atrPeriod);

    const price = view.close.at(-1) ?? null;
    const upper = lastValue(bands.upper);
    const lower = lastValue(bands.lower);
    const middle = lastValue(bands.middle);
    const percentB = lastValue(bands.percentB);
    const momentum = lastValue(rsiSeries);
    const strength = lastValue(adxSeries);
    const range = lastValue(atrSeries);
    const atrPercent = range !== null && price !== null ? safeDivide(range, price) * 100 : null;

    const indicators = [
      snapshot('bb_upper', `BB upper(${bandPeriod})`, upper, 'neutral'),
      snapshot('bb_middle', `BB middle(${bandPeriod})`, middle, 'neutral'),
      snapshot('bb_lower', `BB lower(${bandPeriod})`, lower, 'neutral'),
      snapshot('bb_percent_b', '%B', percentB, 'neutral', '0 = lower band, 1 = upper band.'),
      snapshot('rsi', `RSI(${rsiPeriod})`, momentum, 'neutral'),
      snapshot('adx', `ADX(${adxPeriod})`, strength, 'neutral', 'Trend strength, not direction.'),
      snapshot('atr_percent', 'ATR %', atrPercent, 'neutral'),
    ];

    if (
      price === null ||
      upper === null ||
      lower === null ||
      middle === null ||
      momentum === null
    ) {
      return abstain(
        ID,
        VERSION,
        'indicators not ready for this window',
        expirationSeconds,
        indicators,
      );
    }

    const belowLower = price <= lower;
    const aboveUpper = price >= upper;
    const direction: SignalDirection =
      belowLower && momentum <= rsiOversold
        ? 'call'
        : aboveUpper && momentum >= rsiOverbought
          ? 'put'
          : 'none';

    const regimeHint: MarketRegime =
      atrPercent !== null && atrPercent > maxAtrPercent * 1.5
        ? 'volatile'
        : strength !== null && strength > maxAdx
          ? 'trend_up'
          : 'range';

    if (direction === 'none') {
      return {
        strategyId: ID,
        strategyVersion: VERSION,
        direction: 'none',
        indicators,
        confirmations: [],
        conflicts: [],
        regimeHint: regimeHint === 'trend_up' ? 'trend_up' : regimeHint,
        expirationSeconds,
        notes: [
          `Price is inside the bands or RSI is not stretched (%B ${percentB === null ? 'n/a' : round(percentB, 2)}, RSI ${round(momentum, 1)}).`,
        ],
        abstainReason: 'no stretch beyond the bands with an RSI extreme',
      };
    }

    const isCall = direction === 'call';
    const bandEdge = isCall ? lower : upper;
    const stretch = safeDivide(Math.abs(price - bandEdge), price) * 10_000;
    const distanceToMean = safeDivide(Math.abs(middle - price), price) * 10_000;

    const confirmations: Confirmation[] = [
      confirmation(
        'band_stretch',
        'Outside band',
        normalizeRange(stretch, 0, 20),
        `Price is ${round(stretch, 1)} bps beyond the ${isCall ? 'lower' : 'upper'} band.`,
      ),
      confirmation(
        'rsi_extreme',
        'RSI extreme',
        normalizeRange(isCall ? rsiOversold - momentum : momentum - rsiOverbought, 0, 15),
        `RSI is ${round(momentum, 1)} (${isCall ? `<= ${rsiOversold}` : `>= ${rsiOverbought}`}).`,
      ),
      confirmation(
        'reversion_room',
        'Room to the mean',
        normalizeRange(distanceToMean, 2, 40),
        `Mean is ${round(distanceToMean, 1)} bps away.`,
      ),
    ];

    if (strength !== null && strength <= maxAdx) {
      confirmations.push(
        confirmation(
          'range_conditions',
          'Range conditions',
          normalizeRange(maxAdx - strength, 0, maxAdx),
          `ADX ${round(strength, 1)} is at or below the ${maxAdx} ceiling.`,
        ),
      );
    }

    const conflicts: Conflict[] = [];

    if (strength !== null && strength > maxAdx) {
      conflicts.push(
        conflict(
          'trending_market',
          'Market is trending',
          normalizeRange(strength - maxAdx, 0, 20),
          strength > maxAdx * 1.5 ? 'blocking' : 'major',
          `ADX ${round(strength, 1)} exceeds the ${maxAdx} ceiling; fading a trend is high risk.`,
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
        `Price stretched beyond the ${isCall ? 'lower' : 'upper'} band with RSI ${round(momentum, 1)}.`,
        'Counter-trend setup: it depends on the range holding.',
      ],
    };
  },
};
